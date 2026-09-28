import { and, desc, eq, isNull } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseHistory,
  cases,
  merchantPortalPasswordCodes,
  merchants,
  queues,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { decryptSecret, encryptSecret } from '../../lib/secret-box'
import { assertCanWorkCase } from './case-access.service'
import { getMidCreationCredentials } from './case-detail-lookups'

// 32 symbols without look-alikes (0/O, 1/I). 32 divides 256, so masking a
// random byte keeps every symbol equally likely. 10 symbols = 50 bits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 10

export type PortalPasswordCodeStatus = {
  status: 'active' | 'used'
  createdAt: string
  consumedAt: string | null
}

function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte & 31]).join('')
}

// The row id is the associated data, so a ciphertext only decrypts on the
// row it was written for.
function codeAssociatedData(codeId: string, merchantId: string) {
  return `merchant-portal-password-code:${codeId}:${merchantId}`
}

function activeCodeCondition(merchantId: string) {
  return and(
    eq(merchantPortalPasswordCodes.merchantId, merchantId),
    isNull(merchantPortalPasswordCodes.consumedAt),
    isNull(merchantPortalPasswordCodes.supersededAt),
  )
}

// MID Creation generates the code; Testing may too, for merchants whose MID
// case closed before codes existed. Either way only the working owner.
async function loadCodeCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      merchantId: cases.merchantId,
      ownerId: cases.ownerId,
      status: cases.status,
      workflowType: queues.workflowType,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.workflowType !== 'mid' && row.workflowType !== 'testing') {
    throw new AppError(
      400,
      'Portal password codes are only available for MID Creation and Testing cases.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(
      403,
      'Only the case owner can manage the portal password code.',
    )
  }
  await assertCanWorkCase(caseId, userId)
  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function getPortalPasswordCodeStatus(
  merchantId: string,
): Promise<PortalPasswordCodeStatus | null> {
  const db = getDb()
  const [row] = await db
    .select({
      createdAt: merchantPortalPasswordCodes.createdAt,
      consumedAt: merchantPortalPasswordCodes.consumedAt,
    })
    .from(merchantPortalPasswordCodes)
    .where(
      and(
        eq(merchantPortalPasswordCodes.merchantId, merchantId),
        isNull(merchantPortalPasswordCodes.supersededAt),
      ),
    )
    .orderBy(desc(merchantPortalPasswordCodes.createdAt))
    .limit(1)

  if (!row) return null
  return {
    status: row.consumedAt ? 'used' : 'active',
    createdAt: row.createdAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
  }
}

export async function generatePortalPasswordCode(
  caseId: string,
  userId: string,
) {
  const caseRow = await loadCodeCase(caseId, userId)
  const db = getDb()
  const code = generateCode()
  const codeId = crypto.randomUUID()
  const codeCiphertext = await encryptSecret(
    code,
    codeAssociatedData(codeId, caseRow.merchantId),
  )

  const createdAt = await db.transaction(async (tx) => {
    // Serialises concurrent generations for one merchant, so the partial
    // unique index never sees two active codes.
    await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, caseRow.merchantId))
      .for('update')

    const [latest] = await tx
      .select({ consumedAt: merchantPortalPasswordCodes.consumedAt })
      .from(merchantPortalPasswordCodes)
      .where(
        and(
          eq(merchantPortalPasswordCodes.merchantId, caseRow.merchantId),
          isNull(merchantPortalPasswordCodes.supersededAt),
        ),
      )
      .orderBy(desc(merchantPortalPasswordCodes.createdAt))
      .limit(1)
    if (latest?.consumedAt) {
      throw new AppError(
        409,
        'Credentials were already sent with this merchant’s portal password code.',
      )
    }

    const now = new Date()
    await tx
      .update(merchantPortalPasswordCodes)
      .set({ supersededAt: now, codeCiphertext: null })
      .where(activeCodeCondition(caseRow.merchantId))
    await tx.insert(merchantPortalPasswordCodes).values({
      id: codeId,
      merchantId: caseRow.merchantId,
      caseId,
      codeCiphertext,
      createdBy: userId,
      createdAt: now,
    })
    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'portal_password_code_generated',
      details: { codeId, replacedPrevious: latest !== undefined },
      createdAt: now,
    })
    return now
  })

  return {
    code,
    createdAt: createdAt.toISOString(),
    portalEmail: await getSavedPortalEmail(caseRow.merchantId),
  }
}

// Lets the Testing case show the full password; the MID case uses its form.
async function getSavedPortalEmail(merchantId: string) {
  const credentials = await getMidCreationCredentials(merchantId)
  return credentials?.email ?? null
}

export async function revealPortalPasswordCode(caseId: string, userId: string) {
  const caseRow = await loadCodeCase(caseId, userId)
  const active = await getActivePortalPasswordCode(caseRow.merchantId)
  if (!active) {
    throw new AppError(404, 'No portal password code has been generated.')
  }

  await getDb().insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'portal_password_code_revealed',
    details: { codeId: active.id },
  })

  return {
    code: active.code,
    createdAt: active.createdAt.toISOString(),
    portalEmail: await getSavedPortalEmail(caseRow.merchantId),
  }
}

export async function getActivePortalPasswordCode(merchantId: string) {
  const [row] = await getDb()
    .select({
      id: merchantPortalPasswordCodes.id,
      codeCiphertext: merchantPortalPasswordCodes.codeCiphertext,
      createdAt: merchantPortalPasswordCodes.createdAt,
    })
    .from(merchantPortalPasswordCodes)
    .where(activeCodeCondition(merchantId))
    .limit(1)

  if (!row?.codeCiphertext) return null
  const code = await decryptSecret(
    row.codeCiphertext,
    codeAssociatedData(row.id, merchantId),
  )
  return { id: row.id, code, createdAt: row.createdAt }
}

export async function requireActivePortalPasswordCode(merchantId: string) {
  const active = await getActivePortalPasswordCode(merchantId)
  if (!active) {
    throw new AppError(
      400,
      'Generate the portal password code and set it on the merchant portal before sending credentials.',
    )
  }
  return active
}

// Called once the credentials have gone out: the code is spent and its
// ciphertext dropped, leaving only the audit row.
export async function consumePortalPasswordCode(codeId: string) {
  await getDb()
    .update(merchantPortalPasswordCodes)
    .set({ consumedAt: new Date(), codeCiphertext: null })
    .where(
      and(
        eq(merchantPortalPasswordCodes.id, codeId),
        isNull(merchantPortalPasswordCodes.consumedAt),
        isNull(merchantPortalPasswordCodes.supersededAt),
      ),
    )
}
