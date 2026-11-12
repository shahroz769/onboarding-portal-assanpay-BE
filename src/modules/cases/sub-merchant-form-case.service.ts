import { and, eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseFiles,
  caseHistory,
  cases,
  merchants,
  queues,
  subMerchantFormDetails,
  subMerchantDraftTemplates,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { cleanUploadFileName } from '../../lib/storage/file-names'
import { createTrackedUpload } from '../../lib/storage/tracked-upload'
import { supersedeStorageObjects } from '../../lib/storage/ownership'
import type { SelectSubMerchantFormInput } from './cases.schemas'
import {
  SUB_MERCHANT_EMAIL_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_KIND,
} from './case-constants'
import { assertCanWorkCase } from './case-access.service'
import { notSentEmailFields, sentEmailFields } from './case-email-send-state'

import { ensureInheritedSubMerchantFormDetails } from './case-detail-lookups'
import {
  validateSubMerchantFinalFormFile,
  validateWordpressScreenshotFile,
} from './case-upload-validation'
import { ensurePrivateInternalCaseFolder } from './case-drive-folders'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'

export async function loadSubMerchantFormCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      currentStageId: cases.currentStageId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      queueId: cases.queueId,
      queueName: queues.name,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
      priority: cases.priority,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Case not found.')
  }

  if (row.workflowType !== 'sub_merchant_form') {
    throw new AppError(
      400,
      'This action is only available for EP Sub-Merchant Form cases.',
    )
  }

  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }
  await assertCanWorkCase(caseId, userId)

  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function selectSubMerchantForm(
  caseId: string,
  userId: string,
  input: SelectSubMerchantFormInput,
) {
  const db = getDb()
  const caseRow = await loadSubMerchantFormCase(caseId, userId)
  const subMerchant = await db.query.subMerchantDraftTemplates.findFirst({
    where: eq(subMerchantDraftTemplates.id, input.subMerchantKey),
    columns: {
      id: true,
      name: true,
      googleDriveWebViewLink: true,
    },
  })

  if (!subMerchant) {
    throw new AppError(400, 'Invalid sub-merchant selection.')
  }

  const now = new Date()
  const [details] = await db.transaction(async (tx) => {
    const [upserted] = await tx
      .insert(subMerchantFormDetails)
      .values({
        caseId,
        subMerchantKey: subMerchant.id,
        subMerchantName: subMerchant.name,
        draftUrl: subMerchant.googleDriveWebViewLink,
        ...notSentEmailFields(),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subMerchantFormDetails.caseId,
        set: {
          subMerchantKey: subMerchant.id,
          subMerchantName: subMerchant.name,
          draftUrl: subMerchant.googleDriveWebViewLink,
          ...notSentEmailFields(),
          updatedAt: now,
        },
      })
      .returning()

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'sub_merchant_selected',
      details: {
        subMerchantKey: subMerchant.id,
        subMerchantName: subMerchant.name,
        caseNumber: caseRow.caseNumber,
      },
    })

    return [upserted]
  })

  return details
}

export async function uploadSubMerchantFinalForm(
  caseId: string,
  userId: string,
  input: {
    file: File
    subMerchantKey: string
  },
) {
  const db = getDb()
  const caseRow = await loadSubMerchantFormCase(caseId, userId)
  const file = input.file
  await validateSubMerchantFinalFormFile(file)

  const details = await ensureInheritedSubMerchantFormDetails({
    caseId,
    merchantId: caseRow.merchantId,
    actorId: userId,
  })

  if (!details) {
    throw new AppError(
      400,
      'Select a sub-merchant in the document review case before uploading the Final Form.',
    )
  }

  if (
    input.subMerchantKey.trim() &&
    input.subMerchantKey !== details.subMerchantKey
  ) {
    throw new AppError(
      400,
      'Final Form must be uploaded for the inherited sub-merchant.',
    )
  }

  const existingFile = details.finalFormId
    ? await db.query.caseFiles.findFirst({
        where: eq(caseFiles.id, details.finalFormId),
      })
    : null

  const storage = new GoogleDriveStorageProvider()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'Sub-Merchant Final Form',
    storage,
  })
  const attempt = createTrackedUpload({
    storage,
    visibility: 'private',
    merchantId: caseRow.merchantId,
    caseId,
  })
  const uploaded = await attempt.upload(
    folder.folderId,
    {
      fileName: cleanUploadFileName(file.name),
      mimeType: file.type,
      file,
    },
    { role: SUB_MERCHANT_FINAL_FORM_KIND },
  )

  const now = new Date()
  const [savedFile] = await attempt.run(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(subMerchantFormDetails)
        .values({
          caseId,
          subMerchantKey: details.subMerchantKey,
          subMerchantName: details.subMerchantName,
          draftUrl: details.draftUrl,
          ...notSentEmailFields(),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: subMerchantFormDetails.caseId,
          set: {
            subMerchantKey: details.subMerchantKey,
            subMerchantName: details.subMerchantName,
            draftUrl: details.draftUrl,
            ...notSentEmailFields(),
            updatedAt: now,
          },
        })

      const [caseFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: SUB_MERCHANT_FINAL_FORM_KIND,
          originalName: cleanUploadFileName(file.name),
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          googleDriveFileId: uploaded.fileId,
          googleDriveWebViewLink: uploaded.webViewLink,
          googleDriveDownloadLink: uploaded.downloadLink,
          googleDriveFolderId: uploaded.folderId,
          uploadedBy: userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [caseFiles.caseId, caseFiles.fileKind],
          set: {
            originalName: cleanUploadFileName(file.name),
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            googleDriveFileId: uploaded.fileId,
            googleDriveWebViewLink: uploaded.webViewLink,
            googleDriveDownloadLink: uploaded.downloadLink,
            googleDriveFolderId: uploaded.folderId,
            uploadedBy: userId,
            updatedAt: now,
          },
        })
        .returning()

      if (!caseFile) {
        throw new AppError(500, 'Failed to save Final Form.')
      }

      await tx
        .update(subMerchantFormDetails)
        .set({
          finalFormFileId: caseFile.id,
          ...notSentEmailFields(),
          updatedAt: now,
        })
        .where(eq(subMerchantFormDetails.caseId, caseId))

      await tx.insert(caseHistory).values({
        caseId,
        actorId: userId,
        action: 'sub_merchant_final_form_uploaded',
        details: {
          fileName: cleanUploadFileName(file.name),
          sizeBytes: uploaded.sizeBytes,
          subMerchantName: details.subMerchantName,
        },
      })

      await attempt.commit(tx)
      return [caseFile]
    }),
  )

  if (existingFile && existingFile.googleDriveFileId !== uploaded.fileId) {
    await supersedeStorageObjects([existingFile.googleDriveFileId])
  }

  return savedFile
}

export async function uploadSubMerchantEmailProof(
  caseId: string,
  userId: string,
  input: { file: File },
) {
  const db = getDb()
  const caseRow = await loadSubMerchantFormCase(caseId, userId)
  const file = input.file
  await validateWordpressScreenshotFile(file)

  const details = await ensureInheritedSubMerchantFormDetails({
    caseId,
    merchantId: caseRow.merchantId,
    actorId: userId,
  })

  if (!details) {
    throw new AppError(
      400,
      'Select a sub-merchant in the document review case before uploading proof.',
    )
  }

  if (!details.finalFormId) {
    throw new AppError(400, 'Upload the Final Form before uploading proof.')
  }

  const existingFile = await db.query.caseFiles.findFirst({
    where: and(
      eq(caseFiles.caseId, caseId),
      eq(caseFiles.fileKind, SUB_MERCHANT_EMAIL_PROOF_KIND),
    ),
  })

  const storage = new GoogleDriveStorageProvider()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'Email Proofs',
    storage,
  })
  const attempt = createTrackedUpload({
    storage,
    visibility: 'private',
    merchantId: caseRow.merchantId,
    caseId,
  })
  const uploaded = await attempt.upload(
    folder.folderId,
    {
      fileName: cleanUploadFileName(file.name),
      mimeType: file.type,
      file,
    },
    { role: SUB_MERCHANT_EMAIL_PROOF_KIND },
  )

  const now = new Date()
  const [savedFile] = await attempt.run(() =>
    db.transaction(async (tx) => {
      const [caseFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: SUB_MERCHANT_EMAIL_PROOF_KIND,
          originalName: cleanUploadFileName(file.name),
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          googleDriveFileId: uploaded.fileId,
          googleDriveWebViewLink: uploaded.webViewLink,
          googleDriveDownloadLink: uploaded.downloadLink,
          googleDriveFolderId: uploaded.folderId,
          uploadedBy: userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [caseFiles.caseId, caseFiles.fileKind],
          set: {
            originalName: cleanUploadFileName(file.name),
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            googleDriveFileId: uploaded.fileId,
            googleDriveWebViewLink: uploaded.webViewLink,
            googleDriveDownloadLink: uploaded.downloadLink,
            googleDriveFolderId: uploaded.folderId,
            uploadedBy: userId,
            updatedAt: now,
          },
        })
        .returning()

      if (!caseFile) {
        throw new AppError(500, 'Failed to save email proof.')
      }

      await tx
        .update(subMerchantFormDetails)
        .set({
          // A manual copy: no email_log row tracks it.
          ...sentEmailFields({
            recipient: 'Manual Gmail',
            emailLogId: null,
            sentAt: now,
          }),
          updatedAt: now,
        })
        .where(eq(subMerchantFormDetails.caseId, caseId))

      await tx.insert(caseHistory).values({
        caseId,
        actorId: userId,
        action: 'sub_merchant_manual_email_proof_uploaded',
        details: {
          fileName: cleanUploadFileName(file.name),
          sizeBytes: uploaded.sizeBytes,
          subMerchantName: details.subMerchantName,
        },
        createdAt: now,
      })

      await attempt.commit(tx)
      return [caseFile]
    }),
  )

  if (existingFile && existingFile.googleDriveFileId !== uploaded.fileId) {
    await supersedeStorageObjects([existingFile.googleDriveFileId])
  }

  return savedFile
}

// ─── Apply Resubmission (called from public route) ──────────────────────────
