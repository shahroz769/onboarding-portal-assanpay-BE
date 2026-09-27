import { and, eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  agreementCaseDetails,
  caseFiles,
  caseHistory,
  cases,
  merchants,
  queues,
  queueStages,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { supersedeStorageObjects } from '../../lib/storage/ownership'
import { sendEmail } from '../email/email.service'
import {
  AgreementEmail,
  agreementEmailSubject,
} from '../email/templates/agreement'
import {
  getConfiguredAgreementDraftForMerchantType,
  getMerchantPortalSettings,
} from '../configuration/configuration.service'
import type { SendAgreementEmailInput } from './cases.schemas'
import {
  AGREEMENT_RECEIVED_FILE_KIND,
  AGREEMENT_FINAL_FILE_KIND,
} from './agreement.config'
import { assertCanWorkCase } from './case-access.service'

import type { DbTransaction } from './case-db'
import {
  assertAutoEmailEnabled,
  resolveCaseEmailRecipients,
  resolveMerchantEmailRecipient,
} from './case-communication-helpers'
import {
  validateAgreementFile,
  validateReceivedAgreementFile,
} from './case-upload-validation'
import {
  ensurePrivateInternalCaseFolder,
  ensurePublicFinalAgreementFolder,
} from './case-drive-folders'
import { getCaseFileStorage } from './case-storage'

export type AgreementEmailResult = {
  status: 'sent' | 'failed'
  emailLogId: string
  error?: string
}

export async function loadAgreementCase(
  caseId: string,
  userId: string,
  options: { allowAwaitingMerchant?: boolean } = {},
) {
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
      merchantBusinessEmail: merchants.businessEmail,
      merchantType: merchants.merchantType,
      queueId: cases.queueId,
      queueName: queues.name,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.workflowType !== 'agreement') {
    throw new AppError(
      400,
      'This action is only available for Agreement cases.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }
  await assertCanWorkCase(caseId, userId)
  if (
    row.status !== 'working' &&
    !(options.allowAwaitingMerchant && row.status === 'awaiting_merchant')
  ) {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function ensureAgreementDetails(
  tx: DbTransaction,
  caseId: string,
  merchantType: string,
) {
  const draft = await getConfiguredAgreementDraftForMerchantType(merchantType)
  const now = new Date()
  const [details] = await tx
    .insert(agreementCaseDetails)
    .values({
      caseId,
      businessType: merchantType,
      draftKey: draft.key,
      draftLabel: draft.label,
      draftUrl: draft.draftUrl,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agreementCaseDetails.caseId,
      set: {
        businessType: merchantType,
        draftKey: draft.key,
        draftLabel: draft.label,
        draftUrl: draft.draftUrl,
        updatedAt: now,
      },
    })
    .returning()

  if (!details) {
    throw new AppError(500, 'Failed to prepare Agreement details.')
  }

  return details
}

export async function uploadAgreementFinalAgreement(
  caseId: string,
  userId: string,
  input: { file: File },
) {
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId)
  const file = input.file
  await validateAgreementFile(file)

  const existingDetails = await db.query.agreementCaseDetails.findFirst({
    where: eq(agreementCaseDetails.caseId, caseId),
  })
  if (existingDetails?.emailStatus === 'sent') {
    throw new AppError(
      400,
      'The Final Agreement cannot be replaced after the email has been sent.',
    )
  }
  const existingFile = existingDetails?.finalAgreementFileId
    ? await db.query.caseFiles.findFirst({
        where: eq(caseFiles.id, existingDetails.finalAgreementFileId),
      })
    : null

  const storage = getCaseFileStorage()
  const folder = await ensurePublicFinalAgreementFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    storage,
  })
  const uploaded = await storage.uploadFile(folder.folderId, {
    fileName: file.name,
    mimeType: file.type,
    file,
  })

  const now = new Date()
  const [savedFile] = await db.transaction(async (tx) => {
    await ensureAgreementDetails(tx, caseId, caseRow.merchantType)

    const [caseFile] = await tx
      .insert(caseFiles)
      .values({
        caseId,
        fileKind: AGREEMENT_FINAL_FILE_KIND,
        originalName: file.name,
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
          originalName: file.name,
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
      throw new AppError(500, 'Failed to save Final Agreement.')
    }

    await tx
      .update(agreementCaseDetails)
      .set({
        finalAgreementFileId: caseFile.id,
        receivedAgreementFileId: null,
        emailStatus: 'not_sent',
        emailLogId: null,
        emailSentAt: null,
        emailRecipient: null,
        updatedAt: now,
      })
      .where(eq(agreementCaseDetails.caseId, caseId))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'agreement_final_uploaded',
      details: { fileName: file.name, sizeBytes: uploaded.sizeBytes },
    })

    return [caseFile]
  })

  if (existingFile && existingFile.googleDriveFileId !== uploaded.fileId) {
    await supersedeStorageObjects([existingFile.googleDriveFileId])
  }

  return savedFile
}

export async function sendAgreementToClient(
  caseId: string,
  userId: string,
  input: SendAgreementEmailInput = {},
): Promise<AgreementEmailResult> {
  await assertAutoEmailEnabled()
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId)

  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )
  // Resolved before the case changes state, so a lookup failure leaves it
  // untouched.
  const extraRecipients = await resolveCaseEmailRecipients({
    actorId: userId,
    merchant: {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    recipient,
  })

  const details = await db.query.agreementCaseDetails.findFirst({
    where: eq(agreementCaseDetails.caseId, caseId),
  })
  if (!details?.finalAgreementFileId) {
    throw new AppError(400, 'Upload the Final Agreement before sending mail.')
  }

  const finalAgreement = await db.query.caseFiles.findFirst({
    where: eq(caseFiles.id, details.finalAgreementFileId),
  })
  if (!finalAgreement) {
    throw new AppError(400, 'The Final Agreement file could not be found.')
  }

  const merchantPortal = await getMerchantPortalSettings()
  const officeAddress = merchantPortal.officeAddress.trim()
  const legalEmail = merchantPortal.legalEmail.trim()
  if (!officeAddress) {
    throw new AppError(
      400,
      'Configure the office address before sending the Agreement email.',
    )
  }
  if (!legalEmail) {
    throw new AppError(
      400,
      'Configure the legal email before sending the Agreement email.',
    )
  }

  const remarks = input.remarks?.trim() || null

  const awaitingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, 'awaiting_merchant'),
    ),
  })
  if (!awaitingStage) {
    throw new AppError(
      500,
      'No awaiting_merchant stage configured for this queue.',
    )
  }

  const [reservedCase] = await db
    .update(cases)
    .set({
      status: 'awaiting_merchant',
      currentStageId: awaitingStage.id,
      updatedAt: new Date(),
    })
    .where(and(eq(cases.id, caseId), eq(cases.status, 'working')))
    .returning({ id: cases.id })
  if (!reservedCase) {
    throw new AppError(409, 'This case has already been sent to the merchant.')
  }

  const emailResult = await sendEmail({
    to: recipient.email,
    ...extraRecipients,
    subject: agreementEmailSubject(caseRow.merchantName),
    template: 'agreement',
    react: AgreementEmail({
      merchantName: caseRow.merchantName,
      ownerName: caseRow.merchantOwnerName,
      agreementUrl: finalAgreement.googleDriveWebViewLink,
      officeAddress,
      legalEmail,
      remarks,
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `agreement/${caseId}/${details.updatedAt.getTime()}`,
    metadata: {
      finalAgreementFileId: details.finalAgreementFileId,
      officeAddress,
      legalEmail,
      remarks,
      recipientEmailType: recipient.recipientEmailType,
    },
  })

  const now = new Date()
  if (emailResult.status === 'failed') {
    await db
      .update(cases)
      .set({
        status: 'working',
        currentStageId: caseRow.currentStageId,
        updatedAt: now,
      })
      .where(eq(cases.id, caseId))
  }

  await db.transaction(async (tx) => {
    await tx
      .update(agreementCaseDetails)
      .set({
        emailStatus: emailResult.status,
        emailLogId: emailResult.emailLogId,
        emailSentAt: emailResult.status === 'sent' ? now : null,
        emailRecipient: recipient.email,
        lastRejectionRemarks: remarks,
        updatedAt: now,
      })
      .where(eq(agreementCaseDetails.caseId, caseId))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action:
        emailResult.status === 'sent'
          ? 'agreement_email_sent'
          : 'agreement_email_failed',
      details: {
        emailLogId: emailResult.emailLogId,
        recipient: recipient.email,
        cc: emailResult.cc,
        bcc: emailResult.bcc,
        replyTo: emailResult.replyTo,
        recipientEmailType: recipient.recipientEmailType,
        remarks,
        error: emailResult.error ?? null,
      },
    })
  })

  if (emailResult.status === 'failed') {
    return {
      status: 'failed',
      emailLogId: emailResult.emailLogId,
      error: emailResult.error,
    }
  }

  return {
    status: 'sent',
    emailLogId: emailResult.emailLogId,
  }
}

export async function uploadReceivedAgreement(
  caseId: string,
  userId: string,
  input: { file: File },
) {
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId, {
    allowAwaitingMerchant: true,
  })
  if (caseRow.status !== 'awaiting_merchant') {
    throw new AppError(
      400,
      'The case must be awaiting the signed physical agreement.',
    )
  }

  const details = await db.query.agreementCaseDetails.findFirst({
    where: eq(agreementCaseDetails.caseId, caseId),
  })
  if (!details?.finalAgreementFileId || details.emailStatus !== 'sent') {
    throw new AppError(
      400,
      'Send the Agreement email before uploading the received copy.',
    )
  }

  const file = input.file
  await validateReceivedAgreementFile(file)

  const existingFile = details.receivedAgreementFileId
    ? await db.query.caseFiles.findFirst({
        where: eq(caseFiles.id, details.receivedAgreementFileId),
      })
    : null
  const storage = getCaseFileStorage()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'Received Agreement',
    storage,
  })
  const uploaded = await storage.uploadFile(folder.folderId, {
    fileName: file.name,
    mimeType: file.type,
    file,
  })

  const workingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, 'working'),
    ),
  })
  if (!workingStage) {
    throw new AppError(500, 'No working stage configured for this queue.')
  }

  const now = new Date()
  const [savedFile] = await db.transaction(async (tx) => {
    const [caseFile] = await tx
      .insert(caseFiles)
      .values({
        caseId,
        fileKind: AGREEMENT_RECEIVED_FILE_KIND,
        originalName: file.name,
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
          originalName: file.name,
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
      throw new AppError(500, 'Failed to save the received Agreement.')
    }

    await tx
      .update(agreementCaseDetails)
      .set({ receivedAgreementFileId: caseFile.id, updatedAt: now })
      .where(eq(agreementCaseDetails.caseId, caseId))

    await tx
      .update(cases)
      .set({
        status: 'working',
        currentStageId: workingStage.id,
        updatedAt: now,
      })
      .where(and(eq(cases.id, caseId), eq(cases.status, 'awaiting_merchant')))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'agreement_received_uploaded',
      details: {
        fileName: file.name,
        fileUrl: uploaded.webViewLink,
        sizeBytes: uploaded.sizeBytes,
      },
    })

    return [caseFile]
  })

  if (existingFile && existingFile.googleDriveFileId !== uploaded.fileId) {
    await supersedeStorageObjects([existingFile.googleDriveFileId])
  }

  return savedFile
}
