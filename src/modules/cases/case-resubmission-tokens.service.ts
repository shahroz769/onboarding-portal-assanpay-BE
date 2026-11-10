import { and, eq, inArray, isNull, or } from 'drizzle-orm'

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
  const db = getDb()
  const tokenString = generateTokenString()
  const tokenHash = await hashToken(tokenString)
  const tokenId = await db.transaction(async (tx) => {
    // A case may have only one usable resubmission link. Superseding older
    // previews also prevents a link from a previous rejection round from
    // loading the current round's rejected fields.
    await tx
      .update(caseResubmissionTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(caseResubmissionTokens.caseId, caseId),
          isNull(caseResubmissionTokens.consumedAt),
        ),
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

    return row.id
  })

  return { token: tokenString, tokenId }
}

export const INACTIVE_RESUBMISSION_LINK_MESSAGE =
  'This resubmission link is no longer active.'

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

/** Consumes every unconsumed resubmission link of the given cases. */
export async function consumeOpenResubmissionTokens(
  tx: DbTransaction,
  caseIds: string[],
) {
  if (caseIds.length === 0) return
  await tx
    .update(caseResubmissionTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        inArray(caseResubmissionTokens.caseId, caseIds),
        isNull(caseResubmissionTokens.consumedAt),
      ),
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
    throw new AppError(410, 'This resubmission link has already been used.')
  }

  assertResubmissionTargetOpen(row)

  return { caseId: row.caseId, tokenId: row.id }
}
