import { eq, inArray } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseHistory,
  cases,
  merchantPortalApiCredentials,
  merchants,
  queues,
  users,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { decryptSecret, encryptSecret } from '../../lib/secret-box'
import type { SecretKeyName } from '../../lib/secret-box'
import { assertCanWorkCase } from './case-access.service'
import type { SavePortalApiCredentialsInput } from './cases.schemas'

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

const KEY_NAME: SecretKeyName = 'PORTAL_API_CREDENTIALS_ENCRYPTION_KEY'

type CredentialField = 'apiKey' | 'apiSecret'

export type PortalApiCredentialsStatus = {
  /** Last four characters of the API key; null unless the viewer may see it. */
  apiKeyLast4: string | null
  updatedAt: string
  updatedBy: { id: string; name: string } | null
}

// Binds each ciphertext to its row and field, so a stored key and secret
// cannot be swapped with each other or copied onto another merchant.
function credentialAssociatedData(
  rowId: string,
  merchantId: string,
  field: CredentialField,
) {
  return `merchant-portal-api-credentials:${rowId}:${merchantId}:${field}`
}

// MID Creation saves the credentials; MID Creation and WordPress Website
// reveal them. Always the owner of a working case.
async function loadCredentialsCase(
  caseId: string,
  userId: string,
  allowedWorkflows: ReadonlyArray<'mid' | 'wordpress'>,
) {
  const [row] = await getDb()
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
  if (!allowedWorkflows.includes(row.workflowType as 'mid' | 'wordpress')) {
    throw new AppError(
      400,
      'API credentials are not available for this case type.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can access API credentials.')
  }
  await assertCanWorkCase(caseId, userId)
  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function getPortalApiCredentialsStatus(
  merchantId: string,
  options: { includeKeyHint: boolean },
): Promise<PortalApiCredentialsStatus | null> {
  const [row] = await getDb()
    .select({
      apiKeyLast4: merchantPortalApiCredentials.apiKeyLast4,
      updatedAt: merchantPortalApiCredentials.updatedAt,
      updatedById: merchantPortalApiCredentials.updatedBy,
      updatedByName: users.name,
    })
    .from(merchantPortalApiCredentials)
    .leftJoin(users, eq(merchantPortalApiCredentials.updatedBy, users.id))
    .where(eq(merchantPortalApiCredentials.merchantId, merchantId))
    .limit(1)

  if (!row) return null
  return {
    apiKeyLast4: options.includeKeyHint ? row.apiKeyLast4 : null,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedById
      ? { id: row.updatedById, name: row.updatedByName ?? 'Unknown' }
      : null,
  }
}

export async function hasPortalApiCredentials(merchantId: string) {
  const [row] = await getDb()
    .select({ id: merchantPortalApiCredentials.id })
    .from(merchantPortalApiCredentials)
    .where(eq(merchantPortalApiCredentials.merchantId, merchantId))
    .limit(1)
  return Boolean(row)
}

export async function savePortalApiCredentials(
  caseId: string,
  userId: string,
  input: SavePortalApiCredentialsInput,
) {
  const caseRow = await loadCredentialsCase(caseId, userId, ['mid'])
  const rowId = crypto.randomUUID()
  // Encrypted before the transaction: only ciphertext ever reaches SQL, so a
  // logged query error cannot carry the plaintext.
  const [apiKeyCiphertext, apiSecretCiphertext] = await Promise.all([
    encryptSecret(
      input.apiKey,
      credentialAssociatedData(rowId, caseRow.merchantId, 'apiKey'),
      KEY_NAME,
    ),
    encryptSecret(
      input.apiSecret,
      credentialAssociatedData(rowId, caseRow.merchantId, 'apiSecret'),
      KEY_NAME,
    ),
  ])
  const apiKeyLast4 = input.apiKey.slice(-4)

  const updatedAt = await getDb().transaction(async (tx) => {
    // Serialises concurrent saves for one merchant.
    await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.id, caseRow.merchantId))
      .for('update')

    const replaced = await tx
      .delete(merchantPortalApiCredentials)
      .where(eq(merchantPortalApiCredentials.merchantId, caseRow.merchantId))
      .returning({ id: merchantPortalApiCredentials.id })

    const now = new Date()
    await tx.insert(merchantPortalApiCredentials).values({
      id: rowId,
      merchantId: caseRow.merchantId,
      caseId,
      apiKeyCiphertext,
      apiSecretCiphertext,
      apiKeyLast4,
      updatedBy: userId,
      updatedAt: now,
    })
    // Metadata only: values never go into case history.
    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'portal_api_credentials_saved',
      details: { replacedPrevious: replaced.length > 0 },
      createdAt: now,
    })
    return now
  })

  return { apiKeyLast4, updatedAt: updatedAt.toISOString() }
}

export async function revealPortalApiCredentials(
  caseId: string,
  userId: string,
) {
  const caseRow = await loadCredentialsCase(caseId, userId, [
    'mid',
    'wordpress',
  ])
  const [row] = await getDb()
    .select({
      id: merchantPortalApiCredentials.id,
      apiKeyCiphertext: merchantPortalApiCredentials.apiKeyCiphertext,
      apiSecretCiphertext: merchantPortalApiCredentials.apiSecretCiphertext,
      updatedAt: merchantPortalApiCredentials.updatedAt,
    })
    .from(merchantPortalApiCredentials)
    .where(eq(merchantPortalApiCredentials.merchantId, caseRow.merchantId))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'No API credentials have been saved.')
  }

  const [apiKey, apiSecret] = await Promise.all([
    decryptSecret(
      row.apiKeyCiphertext,
      credentialAssociatedData(row.id, caseRow.merchantId, 'apiKey'),
      KEY_NAME,
    ),
    decryptSecret(
      row.apiSecretCiphertext,
      credentialAssociatedData(row.id, caseRow.merchantId, 'apiSecret'),
      KEY_NAME,
    ),
  ])

  await getDb().insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'portal_api_credentials_revealed',
    details: { credentialId: row.id },
  })

  return { apiKey, apiSecret, updatedAt: row.updatedAt.toISOString() }
}

// Called when the WordPress Website case closes, and when merchants are
// terminated. Deleting the row drops both ciphertexts for good.
export async function clearPortalApiCredentials(
  tx: DbTransaction,
  merchantIds: string[],
) {
  if (merchantIds.length === 0) return []
  const cleared = await tx
    .delete(merchantPortalApiCredentials)
    .where(inArray(merchantPortalApiCredentials.merchantId, merchantIds))
    .returning({ merchantId: merchantPortalApiCredentials.merchantId })
  return cleared.map((row) => row.merchantId)
}
