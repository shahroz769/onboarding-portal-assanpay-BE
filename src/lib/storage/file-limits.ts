import { AppError } from '../errors'

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

export function assertFileSizeLimit(file: File, label = 'File') {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new AppError(413, `${label} exceeds the 10 MB limit.`)
  }
}
