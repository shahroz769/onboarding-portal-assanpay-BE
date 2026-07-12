import { AppError } from '../errors'

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46] // %PDF
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46] // RIFF
const WEBP_WEBP = [0x57, 0x45, 0x42, 0x50] // WEBP
const OLE_COMPOUND = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_LOCAL_FILE = [0x50, 0x4b, 0x03, 0x04]
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06]
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08]

/** Bytes needed to classify supported upload formats. */
export const FILE_SIGNATURE_PROBE_BYTES = 16

export type SupportedUploadFamily =
  | 'pdf'
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'doc'
  | 'docx'

const MIME_TO_FAMILY: Record<string, SupportedUploadFamily> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
}

const EXTENSION_TO_FAMILY: Record<string, SupportedUploadFamily> = {
  pdf: 'pdf',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  doc: 'doc',
  docx: 'docx',
}

/**
 * Reads a bounded prefix of the file and rejects empty, truncated, or
 * content/MIME mismatches before any Drive upload.
 */
export async function assertFileContentSignature(input: {
  file: File
  expectedMimeType?: string | null
  label?: string
}) {
  const label = input.label ?? (input.file.name || 'upload')

  if (input.file.size <= 0) {
    throw new AppError(400, `Document "${label}" is empty.`)
  }

  const expectedFamily = resolveExpectedFamily(
    input.expectedMimeType ?? input.file.type,
    input.file.name,
  )

  if (!expectedFamily) {
    throw new AppError(415, `Document "${label}" has an unsupported file type.`)
  }

  const probeLength = Math.min(
    FILE_SIGNATURE_PROBE_BYTES,
    input.file.size,
  )
  const probe = new Uint8Array(
    await input.file.slice(0, probeLength).arrayBuffer(),
  )

  if (probe.byteLength < minimumBytesForFamily(expectedFamily)) {
    throw new AppError(
      400,
      `Document "${label}" is truncated or corrupted.`,
    )
  }

  const detectedFamily = detectFamily(probe)
  if (!detectedFamily) {
    throw new AppError(
      415,
      `Document "${label}" content does not match a supported file signature.`,
    )
  }

  if (detectedFamily !== expectedFamily) {
    throw new AppError(
      415,
      `Document "${label}" content does not match its declared file type.`,
    )
  }
}

function resolveExpectedFamily(
  mimeType: string | null | undefined,
  fileName: string,
): SupportedUploadFamily | null {
  const normalizedMime = (mimeType || '').toLowerCase()
  if (normalizedMime && MIME_TO_FAMILY[normalizedMime]) {
    return MIME_TO_FAMILY[normalizedMime]
  }

  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_TO_FAMILY[extension] ?? null
}

function minimumBytesForFamily(family: SupportedUploadFamily) {
  switch (family) {
    case 'pdf':
      return PDF_SIGNATURE.length
    case 'jpeg':
      return JPEG_SIGNATURE.length
    case 'png':
      return PNG_SIGNATURE.length
    case 'webp':
      return 12
    case 'doc':
      return OLE_COMPOUND.length
    case 'docx':
      return ZIP_LOCAL_FILE.length
  }
}

function detectFamily(bytes: Uint8Array): SupportedUploadFamily | null {
  if (startsWith(bytes, PDF_SIGNATURE)) return 'pdf'
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png'
  if (
    startsWith(bytes, WEBP_RIFF) &&
    bytes.length >= 12 &&
    startsWith(bytes.subarray(8, 12), WEBP_WEBP)
  ) {
    return 'webp'
  }
  if (startsWith(bytes, OLE_COMPOUND)) return 'doc'
  if (
    startsWith(bytes, ZIP_LOCAL_FILE) ||
    startsWith(bytes, ZIP_EMPTY) ||
    startsWith(bytes, ZIP_SPANNED)
  ) {
    return 'docx'
  }

  return null
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}
