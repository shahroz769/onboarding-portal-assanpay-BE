import type { DbTransaction } from '../../db/client'
import type {
  FileStorageProvider,
  GoogleDriveVisibility,
  StorageUploadInput,
  StorageUploadResult,
} from './google-drive'
import {
  cleanupFailedAttemptObjects,
  createStorageAttemptId,
  markAttemptObjectsCurrent,
  recordStorageObject,
} from './ownership'

/**
 * Drive uploads whose database rows are written afterwards, tracked in
 * storage_objects so a failure never leaves an untracked file in Drive:
 *
 *   const attempt = createTrackedUpload({ storage, visibility, caseId, ... })
 *   await attempt.run(async () => {
 *     const uploaded = await attempt.upload(folderId, { fileName, ... })
 *     await db.transaction(async (tx) => {
 *       ...insert rows pointing at uploaded.fileId...
 *       await attempt.commit(tx)
 *     })
 *   })
 *
 * Each file is recorded as provisioning right after it reaches Drive and
 * becomes current in the transaction that commits the rows pointing at it.
 * If anything inside run() throws first, this attempt's provisioning files
 * are deleted from Drive; committed files never are.
 */
export function createTrackedUpload(input: {
  storage: FileStorageProvider
  visibility: GoogleDriveVisibility
  merchantId?: string | null
  caseId?: string | null
}) {
  const attemptId = createStorageAttemptId()

  async function upload(
    folderId: string,
    file: StorageUploadInput,
    metadata: Record<string, unknown> = {},
  ): Promise<StorageUploadResult> {
    const uploaded = await input.storage.uploadFile(folderId, file)
    try {
      await recordStorageObject({
        providerObjectId: uploaded.fileId,
        objectKind: 'file',
        visibility: input.visibility,
        attemptId,
        merchantId: input.merchantId ?? null,
        caseId: input.caseId ?? null,
        parentProviderObjectId: uploaded.folderId,
        lifecycle: 'provisioning',
        metadata: {
          ...metadata,
          fileName: uploaded.fileName,
          sizeBytes: uploaded.sizeBytes,
        },
      })
    } catch (error) {
      // Not recorded, so cleanup could not find it: remove it now.
      await input.storage.deleteFile(uploaded.fileId).catch((deleteError) => {
        console.error('[tracked-upload] untracked file left in Drive', {
          fileId: uploaded.fileId,
          deleteError,
        })
      })
      throw error
    }
    return uploaded
  }

  /** Call inside the transaction that writes the rows pointing at the files. */
  function commit(tx: DbTransaction) {
    return markAttemptObjectsCurrent(tx, attemptId)
  }

  /** Runs the upload-and-save steps; on failure removes uncommitted files. */
  async function run<T>(steps: () => Promise<T>): Promise<T> {
    try {
      return await steps()
    } catch (error) {
      await cleanupFailedAttemptObjects({
        attemptId,
        storage: input.storage,
      }).catch((cleanupError) => {
        console.error('[tracked-upload] cleanup failed', {
          attemptId,
          cleanupError,
        })
      })
      throw error
    }
  }

  return { attemptId, upload, commit, run }
}
