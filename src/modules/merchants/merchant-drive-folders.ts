import { eq, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { merchants, storageObjects } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import type {
  FileStorageProvider,
  GoogleDriveVisibility,
} from '../../lib/storage/google-drive'
import {
  buildPendingRootClaimObjectId,
  cleanupFailedAttemptObjects,
  createStorageAttemptId,
  finalizeRootClaim,
} from '../../lib/storage/ownership'

export const PRIVATE_KYC_PENDING_PATH = [
  'KYC Documents',
  'Pending Review',
] as const
export const PRIVATE_KYC_APPROVED_PATH = [
  'KYC Documents',
  'Approved Documents',
] as const
export const PRIVATE_KYC_REJECTED_PATH = [
  'KYC Documents',
  'Rejected Documents',
] as const
export const PRIVATE_MERCHANT_RETURNS_PATH = [
  'Merchant Returns',
  'Agreement',
] as const
export const PRIVATE_INTERNAL_CASE_FILES_PATH = [
  'Internal Case Files',
] as const
export const PUBLIC_AGREEMENT_PATH = [
  'Merchant-Sent Documents',
  'Agreement',
] as const

const ROOT_CLAIM_POLL_ATTEMPTS = 20
const ROOT_CLAIM_POLL_DELAY_MS = 100

export function buildMerchantRootFolderName(
  merchantId: string,
  merchantName: string,
) {
  const safeMerchantName = sanitizeDrivePathPart(merchantName, 80)
  return `${safeMerchantName || 'Merchant'} - ${merchantId}`
}

export function buildCaseFolderName(
  caseNumber: string,
  merchantName: string,
  queueName?: string | null,
) {
  const safeMerchantName = sanitizeDrivePathPart(merchantName, 80)
  const baseName = `${caseNumber} - ${safeMerchantName || 'Merchant'}`
  return queueName ? `${baseName} - ${sanitizeDrivePathPart(queueName, 60)}` : baseName
}

export function getSubmissionFolderName(index: number) {
  switch (index) {
    case 1:
      return 'First Submission'
    case 2:
      return 'Second Submission'
    case 3:
      return 'Third Submission'
    default:
      return `Submission ${index}`
  }
}

export function getRejectedRoundFolderName(round: number) {
  return `Round ${String(round).padStart(2, '0')}`
}

export function sanitizeDrivePathPart(value: string, maxLength = 120) {
  return value
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/**
 * Serializes merchant-root provisioning with a short DB claim.
 * Network calls to Google Drive happen outside the claim transaction.
 * Losers wait and re-read; a loser may delete only a root it created under
 * its own attempt (never a find-or-create result without ownership).
 */
export async function ensureMerchantRootFolder(input: {
  merchantId: string
  merchantName: string
  visibility: GoogleDriveVisibility
  storage?: FileStorageProvider
}) {
  const db = getDb()
  const storage = input.storage ?? new GoogleDriveStorageProvider()
  const existingFolderId = await readMerchantRootFolderId(
    input.merchantId,
    input.visibility,
  )
  if (existingFolderId) return existingFolderId

  const attemptId = createStorageAttemptId()
  const claim = await tryClaimMerchantRootProvisioning({
    merchantId: input.merchantId,
    visibility: input.visibility,
    attemptId,
  })

  if (!claim) {
    return waitForMerchantRootFolderId(input.merchantId, input.visibility)
  }

  try {
    if (!storage.createMerchantRootFolder) {
      throw new AppError(
        500,
        'Storage provider does not support claimed merchant root creation.',
      )
    }

    const folder = await storage.createMerchantRootFolder(
      buildMerchantRootFolderName(input.merchantId, input.merchantName),
      input.visibility,
    )

    // Bind the real provider ID before any later failure so attempt cleanup
    // can delete only this attempt's root.
    await finalizeRootClaim({
      claim,
      providerObjectId: folder.folderId,
      parentProviderObjectId: folder.parentFolderId,
    })

    const updated = await db
      .update(merchants)
      .set(
        input.visibility === 'public'
          ? {
              googleDrivePublicFolderId: folder.folderId,
              updatedAt: new Date(),
            }
          : {
              googleDrivePrivateFolderId: folder.folderId,
              updatedAt: new Date(),
            },
      )
      .where(andMerchantMissingRoot(input.merchantId, input.visibility))
      .returning({
        googleDrivePrivateFolderId: merchants.googleDrivePrivateFolderId,
        googleDrivePublicFolderId: merchants.googleDrivePublicFolderId,
      })

    const committedFolderId =
      input.visibility === 'public'
        ? updated[0]?.googleDrivePublicFolderId
        : updated[0]?.googleDrivePrivateFolderId

    if (committedFolderId === folder.folderId) {
      return folder.folderId
    }

    // Another writer already set the merchant root. Keep the winner's folder
    // and delete only the root we created under this attempt.
    await cleanupFailedAttemptObjects({ attemptId, storage })
    return waitForMerchantRootFolderId(input.merchantId, input.visibility)
  } catch (error) {
    await cleanupFailedAttemptObjects({ attemptId, storage }).catch(
      (cleanupError) => {
        console.error('[merchant-root.claim-cleanup]', cleanupError)
      },
    )
    throw error
  }
}

export async function ensureMerchantFolderPath(input: {
  merchantId: string
  merchantName: string
  visibility: GoogleDriveVisibility
  path: string[]
  storage?: FileStorageProvider
}) {
  const storage = input.storage ?? new GoogleDriveStorageProvider()
  const rootFolderId = await ensureMerchantRootFolder({
    merchantId: input.merchantId,
    merchantName: input.merchantName,
    visibility: input.visibility,
    storage,
  })

  return storage.ensureFolderPath(rootFolderId, input.path)
}

async function readMerchantRootFolderId(
  merchantId: string,
  visibility: GoogleDriveVisibility,
) {
  const db = getDb()
  const row = await db.query.merchants.findFirst({
    where: eq(merchants.id, merchantId),
    columns: {
      googleDrivePrivateFolderId: true,
      googleDrivePublicFolderId: true,
    },
  })

  return visibility === 'public'
    ? row?.googleDrivePublicFolderId ?? null
    : row?.googleDrivePrivateFolderId ?? null
}

async function tryClaimMerchantRootProvisioning(input: {
  merchantId: string
  visibility: GoogleDriveVisibility
  attemptId: string
}) {
  const db = getDb()

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`merchant-root:${input.merchantId}:${input.visibility}`}))`,
    )

    const row = await tx.query.merchants.findFirst({
      where: eq(merchants.id, input.merchantId),
      columns: {
        googleDrivePrivateFolderId: true,
        googleDrivePublicFolderId: true,
      },
    })
    const existingFolderId =
      input.visibility === 'public'
        ? row?.googleDrivePublicFolderId
        : row?.googleDrivePrivateFolderId
    if (existingFolderId) return null

    const existingClaim = await tx.query.storageObjects.findFirst({
      where: andRootClaimActive(input.merchantId, input.visibility),
      columns: { id: true },
    })
    if (existingClaim) return null

    const [claim] = await tx
      .insert(storageObjects)
      .values({
        provider: 'google_drive',
        providerObjectId: buildPendingRootClaimObjectId(input.attemptId),
        objectKind: 'folder',
        merchantId: input.merchantId,
        visibility: input.visibility,
        attemptId: input.attemptId,
        lifecycle: 'provisioning',
        metadata: { role: 'merchant_root' },
        updatedAt: new Date(),
      })
      .returning()

    return claim ?? null
  })
}

function andRootClaimActive(
  merchantId: string,
  visibility: GoogleDriveVisibility,
) {
  return sql`${storageObjects.merchantId} = ${merchantId}
    and ${storageObjects.visibility} = ${visibility}
    and (${storageObjects.metadata}->>'role') = 'merchant_root'
    and ${storageObjects.lifecycle} in ('provisioning', 'current')`
}

function andMerchantMissingRoot(
  merchantId: string,
  visibility: GoogleDriveVisibility,
) {
  if (visibility === 'public') {
    return sql`${merchants.id} = ${merchantId} and ${merchants.googleDrivePublicFolderId} is null`
  }

  return sql`${merchants.id} = ${merchantId} and ${merchants.googleDrivePrivateFolderId} is null`
}

async function waitForMerchantRootFolderId(
  merchantId: string,
  visibility: GoogleDriveVisibility,
) {
  for (let attempt = 0; attempt < ROOT_CLAIM_POLL_ATTEMPTS; attempt += 1) {
    const folderId = await readMerchantRootFolderId(merchantId, visibility)
    if (folderId) return folderId
    await sleep(ROOT_CLAIM_POLL_DELAY_MS)
  }

  throw new AppError(
    503,
    'Merchant Drive root is still being provisioned. Retry shortly.',
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
