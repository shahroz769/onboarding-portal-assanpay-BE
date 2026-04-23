import { importPKCS8, SignJWT } from "jose";

import { env } from "../../config/env";
import { AppError } from "../errors";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,webContentLink,parents";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

type GoogleAccessToken = {
  accessToken: string;
  expiresAt: number;
};

type GoogleServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

type GoogleDriveFileResponse = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  webContentLink?: string;
  parents?: string[];
};

export type StorageUploadInput = {
  fileName: string;
  mimeType: string;
  file: File;
};

export type StorageUploadResult = {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  webViewLink: string;
  downloadLink: string | null;
  folderId: string;
};

export interface FileStorageProvider {
  createMerchantFolder(folderName: string): Promise<{ folderId: string }>;
  createFolder(
    parentFolderId: string,
    folderName: string,
  ): Promise<{ folderId: string }>;
  uploadFile(folderId: string, input: StorageUploadInput): Promise<StorageUploadResult>;
  deleteFile(fileId: string): Promise<void>;
}

let tokenCache: GoogleAccessToken | null = null;
let credentialsCache: GoogleServiceAccountCredentials | null = null;
let tokenPromise: Promise<string> | null = null;

export class GoogleDriveStorageProvider implements FileStorageProvider {
  async createMerchantFolder(folderName: string) {
    const parentFolderId = getRequiredEnv("GOOGLE_DRIVE_PARENT_FOLDER_ID");
    return this.createFolder(parentFolderId, folderName);
  }

  async createFolder(parentFolderId: string, folderName: string) {
    const accessToken = await getGoogleAccessToken();
    const response = await fetch(`${GOOGLE_DRIVE_FILES_URL}?supportsAllDrives=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      }),
    });

    if (!response.ok) {
      throw await toStorageError(
        response,
        "Failed to create folder in Google Drive.",
        {
          operation: "create-folder",
          fileId: parentFolderId,
        },
      );
    }

    const data = (await response.json()) as { id: string };
    return { folderId: data.id };
  }

  async uploadFile(folderId: string, input: StorageUploadInput) {
    const accessToken = await getGoogleAccessToken();
    const metadata = {
      name: input.fileName,
      mimeType: input.mimeType,
      parents: [folderId],
    };
    const boundary = `merchant-upload-${crypto.randomUUID()}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
      input.file,
      `\r\n--${boundary}--`,
    ]);

    const response = await fetch(GOOGLE_DRIVE_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      throw await toStorageError(response, `Failed to upload "${input.fileName}" to Google Drive.`, {
        operation: "upload-file",
        fileId: folderId,
      });
    }

    const data = (await response.json()) as GoogleDriveFileResponse;

    return {
      fileId: data.id,
      fileName: data.name,
      mimeType: data.mimeType,
      sizeBytes: input.file.size,
      webViewLink: data.webViewLink,
      downloadLink: data.webContentLink ?? null,
      folderId,
    };
  }

  async deleteFile(fileId: string) {
    const accessToken = await getGoogleAccessToken();
    const response = await fetch(`${GOOGLE_DRIVE_FILES_URL}/${fileId}?supportsAllDrives=true`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw await toStorageError(response, `Failed to delete Google Drive file "${fileId}".`);
    }
  }

  async getFileMetadata(fileId: string) {
    const accessToken = await getGoogleAccessToken();
    const response = await fetch(
      `${GOOGLE_DRIVE_FILES_URL}/${fileId}?supportsAllDrives=true&fields=id,name,parents,mimeType,webViewLink,webContentLink`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw await toStorageError(response, `Failed to read Google Drive metadata for "${fileId}".`);
    }

    return (await response.json()) as GoogleDriveFileResponse;
  }
}

async function getGoogleAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  if (tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
    const credentials = await getGoogleDriveCredentials();
    const clientEmail = credentials.client_email;
    const privateKey = credentials.private_key.replace(/\\n/g, "\n");
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const key = await importPKCS8(privateKey, "RS256");
    const assertion = await new SignJWT({
      scope: GOOGLE_DRIVE_SCOPE,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(clientEmail)
      .setSubject(clientEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(nowInSeconds)
      .setExpirationTime(nowInSeconds + 3600)
      .sign(key);

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    if (!tokenResponse.ok) {
      throw await toStorageError(tokenResponse, "Failed to authenticate with Google Drive.");
    }

    const tokenPayload = (await tokenResponse.json()) as {
      access_token: string;
      expires_in: number;
    };

    tokenCache = {
      accessToken: tokenPayload.access_token,
      expiresAt: Date.now() + tokenPayload.expires_in * 1000,
    };

    return tokenCache.accessToken;
  })();

  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

async function toStorageError(
  response: Response,
  fallbackMessage: string,
  context: {
    operation?: "create-folder" | "upload-file";
    fileId?: string;
  } = {},
) {
  const payloadText = await response.text().catch(() => "");
  console.error("[google-drive]", response.status, payloadText);

  if (response.status === 404) {
    const payload = parseGoogleDriveErrorPayload(payloadText);
    const isMissingDriveFile =
      payload?.error?.errors?.some((error) => error.reason === "notFound") ?? false;

    if (isMissingDriveFile && context.operation === "create-folder" && context.fileId) {
      return new AppError(
        502,
        `Google Drive parent folder "${context.fileId}" was not found or is not accessible to the configured service account. Share the folder with the service account email or use a shared-drive folder ID.`,
      );
    }

    if (isMissingDriveFile && context.operation === "upload-file" && context.fileId) {
      return new AppError(
        502,
        `Google Drive folder "${context.fileId}" was not found or is not accessible to the configured service account. Ensure the folder still exists and the service account can access it.`,
      );
    }
  }

  return new AppError(response.status >= 500 ? 502 : 500, fallbackMessage);
}

function parseGoogleDriveErrorPayload(payload: string) {
  try {
    return JSON.parse(payload) as {
      error?: {
        errors?: Array<{
          reason?: string;
        }>;
      };
    };
  } catch {
    return null;
  }
}

async function getGoogleDriveCredentials() {
  if (credentialsCache) {
    return credentialsCache;
  }

  if (!env.GOOGLE_DRIVE_CLIENT_EMAIL || !env.GOOGLE_DRIVE_PRIVATE_KEY) {
    throw new AppError(
      500,
      "Google Drive credentials are not configured. Set GOOGLE_DRIVE_CLIENT_EMAIL and GOOGLE_DRIVE_PRIVATE_KEY.",
    );
  }

  credentialsCache = {
    client_email: env.GOOGLE_DRIVE_CLIENT_EMAIL,
    private_key: env.GOOGLE_DRIVE_PRIVATE_KEY,
  };

  return credentialsCache;
}

function getRequiredEnv(
  key: "GOOGLE_DRIVE_PARENT_FOLDER_ID",
) {
  const value = env[key];

  if (!value) {
    throw new AppError(500, `${key} is not configured.`);
  }

  return value;
}
