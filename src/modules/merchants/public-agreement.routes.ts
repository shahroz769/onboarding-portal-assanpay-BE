import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'

import { getDb } from '../../db/client'
import {
  agreementCaseDetails,
  caseFiles,
  caseHistory,
  caseResubmissionTokens,
  cases,
  merchants,
  queueStages,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import type { AppEnv } from '../../types/auth'
import { validateToken } from '../cases/case-resubmission-tokens.service'
import { AGREEMENT_CLIENT_FILE_KIND } from '../cases/agreement.config'
import { getAgreementUploadContext } from '../cases/cases.service'
import { notifyOnResubmission } from '../notifications/notifications.service'

export const agreementUploadRoutes = new Hono<AppEnv>()

const MAX_AGREEMENT_BYTES = 1024 * 1024
const AGREEMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const AGREEMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])

agreementUploadRoutes.get('/:token', async (c) => {
  const token = c.req.param('token')
  const validated = await validateToken(token)
  const context = await getAgreementUploadContext(
    validated.caseId,
    validated.expiresAt,
  )
  return c.json(context)
})

agreementUploadRoutes.post('/:token', async (c) => {
  const token = c.req.param('token')
  const validated = await validateToken(token)
  const db = getDb()

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')

  if (!(file instanceof File)) {
    throw new AppError(400, 'Signed agreement file is required.')
  }
  validateAgreementUpload(file)

  const [caseRow] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      ownerId: cases.ownerId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, validated.caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  const workingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, 'working'),
    ),
  })
  if (!workingStage) {
    throw new AppError(500, 'No working stage configured for this queue.')
  }

  const storage = new GoogleDriveStorageProvider()
  const folder = await storage.createMerchantFolder(
    `${caseRow.caseNumber} - ${caseRow.merchantName}`.slice(0, 120),
  )
  const uploaded = await storage.uploadFile(folder.folderId, {
    fileName: file.name,
    mimeType: file.type,
    file,
  })

  const now = new Date()
  await db.transaction(async (tx) => {
    const [caseFile] = await tx
      .insert(caseFiles)
      .values({
        caseId: caseRow.id,
        fileKind: AGREEMENT_CLIENT_FILE_KIND,
        originalName: file.name,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
        googleDriveFileId: uploaded.fileId,
        googleDriveWebViewLink: uploaded.webViewLink,
        googleDriveDownloadLink: uploaded.downloadLink,
        googleDriveFolderId: uploaded.folderId,
        uploadedBy: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [caseFiles.caseId, caseFiles.fileKind],
        set: {
          originalName: file.name,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          googleDriveFileId: uploaded.fileId,
          googleDriveWebViewLink: uploaded.webViewLink,
          googleDriveDownloadLink: uploaded.downloadLink,
          googleDriveFolderId: uploaded.folderId,
          uploadedBy: null,
          updatedAt: now,
        },
      })
      .returning()

    if (!caseFile) {
      throw new AppError(500, 'Failed to save signed agreement.')
    }

    await tx
      .update(agreementCaseDetails)
      .set({
        clientAgreementFileId: caseFile.id,
        updatedAt: now,
      })
      .where(eq(agreementCaseDetails.caseId, caseRow.id))

    const [consumedToken] = await tx
      .update(caseResubmissionTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(caseResubmissionTokens.id, validated.tokenId),
          isNull(caseResubmissionTokens.consumedAt),
        ),
      )
      .returning({ id: caseResubmissionTokens.id })

    if (!consumedToken) {
      throw new AppError(410, 'This agreement link has already been used.')
    }

    await tx
      .update(cases)
      .set({
        status: 'working',
        currentStageId: workingStage.id,
        updatedAt: now,
      })
      .where(eq(cases.id, caseRow.id))

    await tx.insert(caseHistory).values({
      caseId: caseRow.id,
      actorId: null,
      action: 'agreement_client_submitted',
      details: {
        tokenId: validated.tokenId,
        fileName: file.name,
        fileUrl: uploaded.webViewLink,
      },
    })
  })

  if (caseRow.ownerId) {
    await notifyOnResubmission({
      caseId: caseRow.id,
      caseNumber: caseRow.caseNumber,
      ownerId: caseRow.ownerId,
      clientName: caseRow.merchantOwnerName,
      fieldCount: 1,
    }).catch(() => {
      // Notification delivery must not break the upload.
    })
  }

  return c.json({ success: true, caseNumber: caseRow.caseNumber })
})

function validateAgreementUpload(file: File) {
  if (file.size > MAX_AGREEMENT_BYTES) {
    throw new AppError(400, 'Agreement must be 1 MB or smaller.')
  }

  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  if (
    !AGREEMENT_EXTENSIONS.has(extension) ||
    !AGREEMENT_MIME_TYPES.has(file.type || 'application/octet-stream')
  ) {
    throw new AppError(400, 'Agreement must be a PDF, DOC, or DOCX file.')
  }
}
