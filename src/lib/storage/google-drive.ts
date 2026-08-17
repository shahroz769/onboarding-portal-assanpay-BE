import { importPKCS8, SignJWT } from 'jose'

import { env } from '../../config/env'
import { AppError } from '../errors'
import { assertFileSizeLimit } from './file-limits'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const GOOGLE_DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,webContentLink,parents'
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

export type GoogleDriveVisibility = 'private' | 'public'

type GoogleAccessToken = {
  accessToken: string
  expiresAt: number
}

type GoogleServiceAccountCredentials = {
  client_email: string
  private_key: string
}

type GoogleDriveFileResponse = {
  id: string
  name: string
  mimeType: string
  webViewLink: string
  webContentLink?: string
  parents?: string[]
  size?: string
}

export type StorageUploadInput = {
  fileName: string
  mimeType: string
  file: File
}

export type StorageUploadResult = {
  fileId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  webViewLink: string
  downloadLink: string | null
  folderId: string
}

export interface FileStorageProvider {
  createMerchantFolder: (
    folderName: string,
    visibility?: GoogleDriveVisibility,
  ) => Promise<{ folderId: string }>
  createMerchantRootFolder?: (
    folderName: string,
    visibility?: GoogleDriveVisibility,
  ) => Promise<{ folderId: string; parentFolderId: string }>
  createFolder: (
    parentFolderId: string,
    folderName: string,
  ) => Promise<{ folderId: string }>
  findOrCreateFolder: (
    parentFolderId: string,
    folderName: string,
  ) => Promise<{ folderId: string }>
  ensureFolderPath: (
    parentFolderId: string,
    folderPath: string[],
  ) => Promise<{ folderId: string }>
  uploadFile: (
    folderId: string,
    input: StorageUploadInput,
  ) => Promise<StorageUploadResult>
  moveFile: (
    fileId: string,
    destinationFolderId: string,
  ) => Promise<StorageUploadResult>
  deleteFile: (fileId: string) => Promise<void>
}

let tokenCache: GoogleAccessToken | null = null
let credentialsCache: GoogleServiceAccountCredentials | null = null
let tokenPromise: Promise<string> | null = null

export class GoogleDriveStorageProvider implements FileStorageProvider {
  async createMerchantFolder(
    folderName: string,
    visibility: GoogleDriveVisibility = 'private',
  ) {
    const parentFolderId = getRequiredEnv(
      visibility === 'public'
        ? 'GOOGLE_DRIVE_PARENT_FOLDER_ID_PUBLIC'
        : 'GOOGLE_DRIVE_PARENT_FOLDER_ID',
    )
    return this.findOrCreateFolder(parentFolderId, folderName)
  }

  /**
   * Always creates a new merchant root under the configured parent.
   * Used by ownership claim winners so losers never share a find-or-create ID.
   */
  async createMerchantRootFolder(
    folderName: string,
    visibility: GoogleDriveVisibility = 'private',
  ) {
    const parentFolderId = getRequiredEnv(
      visibility === 'public'
        ? 'GOOGLE_DRIVE_PARENT_FOLDER_ID_PUBLIC'
        : 'GOOGLE_DRIVE_PARENT_FOLDER_ID',
    )
    const folder = await this.createFolder(parentFolderId, folderName)
    return { folderId: folder.folderId, parentFolderId }
  }

  async createFolder(parentFolderId: string, folderName: string) {
    const accessToken = await getGoogleAccessToken()
    const response = await fetchGoogleApi(
      `${GOOGLE_DRIVE_FILES_URL}?supportsAllDrives=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
          parents: [parentFolderId],
        }),
      },
      'Unable to connect to Google Drive while creating a folder.',
    )

    if (!response.ok) {
      throw await toStorageError(
        response,
        'Failed to create folder in Google Drive.',
        {
          operation: 'create-folder',
          fileId: parentFolderId,
        },
      )
    }

    const data = (await response.json()) as { id: string }
    return { folderId: data.id }
  }

  async findOrCreateFolder(parentFolderId: string, folderName: string) {
    const existingFolderId = await this.findFolder(parentFolderId, folderName)
    if (existingFolderId) return { folderId: existingFolderId }
    return this.createFolder(parentFolderId, folderName)
  }

  async ensureFolderPath(parentFolderId: string, folderPath: string[]) {
    let folderId = parentFolderId

    for (const folderName of folderPath) {
      const trimmedFolderName = folderName.trim()
      if (!trimmedFolderName) continue

      const folder = await this.findOrCreateFolder(folderId, trimmedFolderName)
      folderId = folder.folderId
    }

    return { folderId }
  }

  async uploadFile(folderId: string, input: StorageUploadInput) {
    assertFileSizeLimit(input.file)
    const accessToken = await getGoogleAccessToken()
    const metadata = {
      name: input.fileName,
      mimeType: input.mimeType,
      parents: [folderId],
    }
    const boundary = `merchant-upload-${crypto.randomUUID()}`
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
      input.file,
      `\r\n--${boundary}--`,
    ])

    const response = await fetchGoogleApi(
      GOOGLE_DRIVE_UPLOAD_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
      `Unable to connect to Google Drive while uploading "${input.fileName}".`,
    )

    if (!response.ok) {
      throw await toStorageError(
        response,
        `Failed to upload "${input.fileName}" to Google Drive.`,
        {
          operation: 'upload-file',
          fileId: folderId,
        },
      )
    }

    const data = (await response.json()) as GoogleDriveFileResponse

    return {
      fileId: data.id,
      fileName: data.name,
      mimeType: data.mimeType,
      sizeBytes: parseDriveSizeBytes(data.size) ?? input.file.size,
      webViewLink: data.webViewLink,
      downloadLink: data.webContentLink ?? null,
      folderId,
    }
  }

  async deleteFile(fileId: string) {
    const accessToken = await getGoogleAccessToken()
    const response = await fetchGoogleApi(
      `${GOOGLE_DRIVE_FILES_URL}/${fileId}?supportsAllDrives=true`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      `Unable to connect to Google Drive while deleting file "${fileId}".`,
    )

    if (!response.ok && response.status !== 404) {
      throw await toStorageError(
        response,
        `Failed to delete Google Drive file "${fileId}".`,
      )
    }
  }

  async moveFile(fileId: string, destinationFolderId: string) {
    const metadata = await this.getFileMetadata(fileId)
    const currentParentIds = metadata.parents ?? []
    const removeParents = currentParentIds
      .filter((parentId) => parentId !== destinationFolderId)
      .join(',')

    if (
      currentParentIds.length === 1 &&
      currentParentIds[0] === destinationFolderId
    ) {
      return toStorageUploadResult(metadata, destinationFolderId)
    }

    const accessToken = await getGoogleAccessToken()
    const params = new URLSearchParams({
      supportsAllDrives: 'true',
      addParents: destinationFolderId,
      fields: 'id,name,mimeType,size,webViewLink,webContentLink,parents',
    })
    if (removeParents) {
      params.set('removeParents', removeParents)
    }

    const response = await fetchGoogleApi(
      `${GOOGLE_DRIVE_FILES_URL}/${fileId}?${params.toString()}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      `Unable to connect to Google Drive while moving file "${fileId}".`,
    )

    if (!response.ok) {
      throw await toStorageError(
        response,
        `Failed to move Google Drive file "${fileId}".`,
      )
    }

    const data = (await response.json()) as GoogleDriveFileResponse
    return toStorageUploadResult(data, destinationFolderId, metadata.size)
  }

  async getFileMetadata(fileId: string) {
    const accessToken = await getGoogleAccessToken()
    const response = await fetchGoogleApi(
      `${GOOGLE_DRIVE_FILES_URL}/${fileId}?supportsAllDrives=true&fields=id,name,parents,mimeType,size,webViewLink,webContentLink`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      `Unable to connect to Google Drive while reading metadata for "${fileId}".`,
    )

    if (!response.ok) {
      throw await toStorageError(
        response,
        `Failed to read Google Drive metadata for "${fileId}".`,
      )
    }

    return (await response.json()) as GoogleDriveFileResponse
  }

  private async findFolder(parentFolderId: string, folderName: string) {
    const accessToken = await getGoogleAccessToken()
    const query = [
      `'${escapeDriveQueryValue(parentFolderId)}' in parents`,
      `name = '${escapeDriveQueryValue(folderName)}'`,
      `mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}'`,
      'trashed = false',
    ].join(' and ')
    const params = new URLSearchParams({
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      q: query,
      fields: 'files(id,name)',
      pageSize: '1',
    })
    const response = await fetchGoogleApi(
      `${GOOGLE_DRIVE_FILES_URL}?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      'Unable to connect to Google Drive while searching for a folder.',
    )

    if (!response.ok) {
      throw await toStorageError(
        response,
        'Failed to search for folder in Google Drive.',
        {
          operation: 'create-folder',
          fileId: parentFolderId,
        },
      )
    }

    const data = (await response.json()) as { files?: Array<{ id: string }> }
    return data.files?.[0]?.id ?? null
  }
}

function toStorageUploadResult(
  data: GoogleDriveFileResponse,
  folderId: string,
  fallbackSize?: string,
): StorageUploadResult {
  return {
    fileId: data.id,
    fileName: data.name,
    mimeType: data.mimeType,
    sizeBytes: parseDriveSizeBytes(data.size) ?? parseDriveSizeBytes(fallbackSize) ?? 0,
    webViewLink: data.webViewLink,
    downloadLink: data.webContentLink ?? null,
    folderId,
  }
}

function parseDriveSizeBytes(size: string | undefined) {
  if (size === undefined || size === '') return null
  const parsed = Number(size)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function getGoogleAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken
  }

  if (tokenPromise) {
    return tokenPromise
  }

  tokenPromise = (async () => {
    const credentials = await getGoogleDriveCredentials()
    const clientEmail = credentials.client_email
    const privateKey = credentials.private_key.replace(/\\n/g, '\n')
    const nowInSeconds = Math.floor(Date.now() / 1000)
    const key = await importPKCS8(privateKey, 'RS256')
    const assertion = await new SignJWT({
      scope: GOOGLE_DRIVE_SCOPE,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(clientEmail)
      .setSubject(clientEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(nowInSeconds)
      .setExpirationTime(nowInSeconds + 3600)
      .sign(key)

    const tokenResponse = await fetchGoogleApi(
      GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      },
      'Unable to connect to Google OAuth while authenticating Google Drive.',
    )

    if (!tokenResponse.ok) {
      throw await toStorageError(
        tokenResponse,
        'Failed to authenticate with Google Drive.',
      )
    }

    const tokenPayload = (await tokenResponse.json()) as {
      access_token: string
      expires_in: number
    }

    tokenCache = {
      accessToken: tokenPayload.access_token,
      expiresAt: Date.now() + tokenPayload.expires_in * 1000,
    }

    return tokenCache.accessToken
  })()

  try {
    return await tokenPromise
  } finally {
    tokenPromise = null
  }
}

async function fetchGoogleApi(
  input: RequestInfo | URL,
  init: RequestInit,
  failureMessage: string,
) {
  try {
    return await fetch(input, init)
  } catch (error) {
    console.error('[google-drive] fetch failed', error)
    throw new AppError(
      502,
      `${failureMessage} Check the server network connection, firewall/proxy settings, and outbound HTTPS access to Google APIs.`,
    )
  }
}

async function toStorageError(
  response: Response,
  fallbackMessage: string,
  context: {
    operation?: 'create-folder' | 'upload-file'
    fileId?: string
  } = {},
) {
  const payloadText = await response.text().catch(() => '')
  console.error('[google-drive]', response.status, payloadText)

  if (response.status === 404) {
    const payload = parseGoogleDriveErrorPayload(payloadText)
    const isMissingDriveFile =
      payload?.error?.errors?.some((error) => error.reason === 'notFound') ??
      false

    if (
      isMissingDriveFile &&
      context.operation === 'create-folder' &&
      context.fileId
    ) {
      return new AppError(
        502,
        `Google Drive parent folder "${context.fileId}" was not found or is not accessible to the configured service account. Share the folder with the service account email or use a shared-drive folder ID.`,
      )
    }

    if (
      isMissingDriveFile &&
      context.operation === 'upload-file' &&
      context.fileId
    ) {
      return new AppError(
        502,
        `Google Drive folder "${context.fileId}" was not found or is not accessible to the configured service account. Ensure the folder still exists and the service account can access it.`,
      )
    }
  }

  return new AppError(response.status >= 500 ? 502 : 500, fallbackMessage)
}

function parseGoogleDriveErrorPayload(payload: string) {
  try {
    return JSON.parse(payload) as {
      error?: {
        errors?: Array<{
          reason?: string
        }>
      }
    }
  } catch {
    return null
  }
}

async function getGoogleDriveCredentials() {
  if (credentialsCache) {
    return credentialsCache
  }

  if (!env.GOOGLE_DRIVE_CLIENT_EMAIL || !env.GOOGLE_DRIVE_PRIVATE_KEY) {
    throw new AppError(
      500,
      'Google Drive credentials are not configured. Set GOOGLE_DRIVE_CLIENT_EMAIL and GOOGLE_DRIVE_PRIVATE_KEY.',
    )
  }

  credentialsCache = {
    client_email: env.GOOGLE_DRIVE_CLIENT_EMAIL,
    private_key: env.GOOGLE_DRIVE_PRIVATE_KEY,
  }

  return credentialsCache
}

function getRequiredEnv(
  key: 'GOOGLE_DRIVE_PARENT_FOLDER_ID' | 'GOOGLE_DRIVE_PARENT_FOLDER_ID_PUBLIC',
) {
  const value = env[key]

  if (!value) {
    throw new AppError(500, `${key} is not configured.`)
  }

  return value
}
