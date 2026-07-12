import {
  PRIVATE_INTERNAL_CASE_FILES_PATH,
  PUBLIC_AGREEMENT_PATH,
  buildCaseFolderName,
  ensureMerchantFolderPath,
} from '../merchants/merchant-drive-folders'
import type { FileStorageProvider } from './case-storage'

export async function ensurePrivateInternalCaseFolder(input: {
  merchantId: string
  merchantName: string
  caseNumber: string
  queueName?: string | null
  section: string
  storage: FileStorageProvider
}) {
  return ensureMerchantFolderPath({
    merchantId: input.merchantId,
    merchantName: input.merchantName,
    visibility: 'private',
    path: [
      ...PRIVATE_INTERNAL_CASE_FILES_PATH,
      buildCaseFolderName(
        input.caseNumber,
        input.merchantName,
        input.queueName,
      ),
      input.section,
    ],
    storage: input.storage,
  })
}

export async function ensurePublicFinalAgreementFolder(input: {
  merchantId: string
  merchantName: string
  caseNumber: string
  storage: FileStorageProvider
}) {
  return ensureMerchantFolderPath({
    merchantId: input.merchantId,
    merchantName: input.merchantName,
    visibility: 'public',
    path: [...PUBLIC_AGREEMENT_PATH, input.caseNumber, 'Final Agreement'],
    storage: input.storage,
  })
}
