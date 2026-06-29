import { eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { merchants } from '../../db/schema'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import type {
  FileStorageProvider,
  GoogleDriveVisibility,
} from '../../lib/storage/google-drive'

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

export async function ensureMerchantRootFolder(input: {
  merchantId: string
  merchantName: string
  visibility: GoogleDriveVisibility
  storage?: FileStorageProvider
}) {
  const db = getDb()
  const storage = input.storage ?? new GoogleDriveStorageProvider()
  const row = await db.query.merchants.findFirst({
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

  if (existingFolderId) return existingFolderId

  const folder = await storage.createMerchantFolder(
    buildMerchantRootFolderName(input.merchantId, input.merchantName),
    input.visibility,
  )

  await db
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
    .where(eq(merchants.id, input.merchantId))

  return folder.folderId
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
