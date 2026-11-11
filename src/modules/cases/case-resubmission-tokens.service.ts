import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm'

import { getDb, type DbTransaction } from '../../db/client'
import { caseResubmissionTokens, cases, merchants } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { hashToken } from '../../lib/security'

export type IssuedToken = {
  token: string
  tokenId: string
}

export type ValidatedToken = {
  caseId: string
  tokenId: string
}

export type ResubmissionTokenConsumedReason = NonNullable<
  (typeof caseResubmissionTokens.$inferSelect)['consumedReason']
>

type TokenExecutor = ReturnType<typeof getDb> | DbTransaction

/**
 * The only writer of consumed_at. A link is active until it is consumed, once,
 * for a reason; migration 0106 rejects reactivating or re-consuming it.
 * Returns the links consumed by this call.
 */
export async function consumeResubmissionTokens(
  db: TokenExecutor,
  where: SQL,
  reason: ResubmissionTokenConsumedReason,
  now = new Date(),
) {
  return db
    .update(caseResubmissionTokens)
    .set({ consumedAt: now, consumedReason: reason })
    .where(and(where, isNull(caseResubmissionTokens.consumedAt)))
    .returning({ id: caseResubmissionTokens.id })
}

function generateTokenString(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

// Resubmission links never expire; a link stays valid until it is used or a
// newer link is issued for the same case.
export async function issueToken(
  caseId: string,
  createdByUserId: string,
): Promise<IssuedToken> {
  return getDb().transaction((tx) =>
    issueTokenInTransaction(tx, caseId, createdByUserId),
  )
}

/** issueToken inside the caller's transaction. */
export async function issueTokenInTransaction(
  tx: DbTransaction,
  caseId: string,
  createdByUserId: string,
): Promise<IssuedToken> {
  const tokenString = generateTokenString()
  const tokenHash = await hashToken(tokenString)

  // A case may have only one usable resubmission link. Superseding older
  // previews also prevents a link from a previous rejection round from
  // loading the current round's rejected fields.
  await consumeResubmissionTokens(
    tx,
    eq(caseResubmissionTokens.caseId, caseId),
    'superseded',
  )

  const [row] = await tx
    .insert(caseResubmissionTokens)
    .values({
      caseId,
      token: null,
      tokenHash,
      createdBy: createdByUserId,
    })
    .returning({ id: caseResubmissionTokens.id })

  if (!row) {
    throw new AppError(500, 'Failed to issue resubmission token.')
  }

  return { token: tokenString, tokenId: row.id }
}

export const INACTIVE_RESUBMISSION_LINK_MESSAGE =
  'This resubmission link is no longer active.'

export const USED_RESUBMISSION_LINK_MESSAGE =
  'This resubmission link has already been used.'

type ResubmissionTarget = {
  caseStatus: (typeof cases.$inferSelect)['status']
  merchantStatus: (typeof merchants.$inferSelect)['status']
  merchantDeletedAt: Date | null
}

/**
 * A link only works while its case is open and its merchant is neither
 * terminated nor deleted. Closing a case consumes its links, but links issued
 * before that rule may still be unconsumed, so the case is checked as well.
 */
export function assertResubmissionTargetOpen(target: ResubmissionTarget) {
  if (
    target.caseStatus === 'closed' ||
    target.merchantStatus === 'terminated' ||
    target.merchantDeletedAt !== null
  ) {
    throw new AppError(410, INACTIVE_RESUBMISSION_LINK_MESSAGE)
  }
}

/** Invalidates every active resubmission link of the given cases. */
export async function consumeOpenResubmissionTokens(
  tx: DbTransaction,
  caseIds: string[],
) {
  if (caseIds.length === 0) return
  await consumeResubmissionTokens(
    tx,
    inArray(caseResubmissionTokens.caseId, caseIds),
    'invalidated',
  )
}

export async function validateToken(token: string): Promise<ValidatedToken> {
  const db = getDb()
  const tokenHash = await hashToken(token)
  const [row] = await db
    .select({
      id: caseResubmissionTokens.id,
      caseId: caseResubmissionTokens.caseId,
      consumedAt: caseResubmissionTokens.consumedAt,
      consumedReason: caseResubmissionTokens.consumedReason,
      caseStatus: cases.status,
      merchantStatus: merchants.status,
      merchantDeletedAt: merchants.deletedAt,
    })
    .from(caseResubmissionTokens)
    .innerJoin(cases, eq(caseResubmissionTokens.caseId, cases.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(
      or(
        eq(caseResubmissionTokens.tokenHash, tokenHash),
        eq(caseResubmissionTokens.token, token),
      ),
    )
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Resubmission link not found.')
  }

  if (row.consumedAt) {
    // Links consumed before the reason was recorded keep the old message.
    throw new AppError(
      410,
      row.consumedReason === 'superseded' ||
        row.consumedReason === 'invalidated'
        ? INACTIVE_RESUBMISSION_LINK_MESSAGE
        : USED_RESUBMISSION_LINK_MESSAGE,
    )
  }

  assertResubmissionTargetOpen(row)

  return { caseId: row.caseId, tokenId: row.id }
}
