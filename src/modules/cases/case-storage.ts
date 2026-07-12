import {
  GoogleDriveStorageProvider,
  type FileStorageProvider,
} from '../../lib/storage/google-drive'

export function getCaseFileStorage(
  storage?: FileStorageProvider,
): FileStorageProvider {
  return storage ?? new GoogleDriveStorageProvider()
}

export type { FileStorageProvider }
