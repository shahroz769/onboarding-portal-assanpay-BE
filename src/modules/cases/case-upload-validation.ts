import { AppError } from '../../lib/errors'
import { assertFileSizeLimit } from '../../lib/storage/file-limits'
import { assertFileContentSignature } from '../../lib/storage/file-signatures'
import {
  AGREEMENT_FILE_EXTENSIONS,
  AGREEMENT_FILE_MIME_TYPES,
  EMAIL_PROOF_MIME_TYPES,
  PHYSICAL_AGREEMENT_EXTENSIONS,
  PHYSICAL_AGREEMENT_MIME_TYPES,
  SUB_MERCHANT_FINAL_FORM_EXTENSIONS,
  SUB_MERCHANT_FINAL_FORM_MIME_TYPES,
  WORDPRESS_SCREENSHOT_EXTENSIONS,
  WORDPRESS_SCREENSHOT_MIME_TYPES,
} from './case-constants'

export function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.[^.]+$/)
  return match?.[0] ?? ''
}

export async function validateSubMerchantFinalFormFile(file: File) {
  assertFileSizeLimit(file, 'Final Form')

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !SUB_MERCHANT_FINAL_FORM_EXTENSIONS.has(extension) ||
    !SUB_MERCHANT_FINAL_FORM_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(400, 'Final Form must be a PDF, DOC, or DOCX file.')
  }

  await assertFileContentSignature({
    file,
    expectedMimeType: mimeType,
    label: 'Final Form',
  })
}

export async function validateWordpressScreenshotFile(file: File) {
  assertFileSizeLimit(file, 'Screenshot')

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !WORDPRESS_SCREENSHOT_EXTENSIONS.has(extension) ||
    !WORDPRESS_SCREENSHOT_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(400, 'Screenshots must be JPG, PNG, or WEBP files.')
  }

  await assertFileContentSignature({
    file,
    expectedMimeType: mimeType,
    label: file.name || 'Screenshot',
  })
}

export async function validateEmailProofFile(file: File) {
  assertFileSizeLimit(file, 'Screenshot')
  const mimeType = file.type || 'application/octet-stream'
  if (!EMAIL_PROOF_MIME_TYPES.has(mimeType)) {
    throw new AppError(400, 'Screenshot must be a JPEG, PNG, or WebP image.')
  }

  await assertFileContentSignature({
    file,
    expectedMimeType: mimeType,
    label: file.name || 'Email proof',
  })
}

export async function validateAgreementFile(file: File) {
  assertFileSizeLimit(file, 'Agreement')

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !AGREEMENT_FILE_EXTENSIONS.has(extension) ||
    !AGREEMENT_FILE_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(400, 'Agreement must be a PDF, DOC, or DOCX file.')
  }

  await assertFileContentSignature({
    file,
    expectedMimeType: mimeType,
    label: 'Agreement',
  })
}

export async function validatePhysicalAgreementFile(file: File) {
  assertFileSizeLimit(file, 'Physical agreement copy')

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !PHYSICAL_AGREEMENT_EXTENSIONS.has(extension) ||
    !PHYSICAL_AGREEMENT_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(
      400,
      'Physical agreement copy must be a PDF, JPG, PNG, or WebP file.',
    )
  }

  await assertFileContentSignature({
    file,
    expectedMimeType: mimeType,
    label: 'Physical agreement copy',
  })
}

export async function validateReceivedAgreementFile(file: File) {
  assertFileSizeLimit(file, 'Received agreement copy')

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !PHYSICAL_AGREEMENT_EXTENSIONS.has(extension) ||
    !PHYSICAL_AGREEMENT_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(
      400,
      'Received agreement copy must be a PDF, JPG, PNG, or WebP file.',
    )
  }

  await assertFileContentSignature({
    file,
    expectedMimeType: mimeType,
    label: 'Received agreement copy',
  })
}
