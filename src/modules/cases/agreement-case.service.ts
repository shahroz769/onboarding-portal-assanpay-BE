import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  agreementCaseDetails,
  caseComments,
  caseLinks,
  caseFiles,
  caseFieldReviews,
  documentReviewDetails,
  caseHistory,
  caseResubmissionTokens,
  cases,
  midGoLiveTokens,
  merchantDocuments,
  merchants,
  portalMidLimitApplications,
  queues,
  queueCaseSequences,
  queueStages,
  subMerchantFormDetails,
  subMerchantDraftTemplates,
  users,
} from '../../db/schema'
import type { Merchant } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { hashToken } from '../../lib/security'
import { env } from '../../config/env'
import type { SessionUser } from '../../types/auth'
import { assertFileContentSignature } from '../../lib/storage/file-signatures'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import { supersedeStorageObjects } from '../../lib/storage/ownership'
import {
  ensureQueueStages,
  getVisibleStagesForQueue,
  getStatusForStage,
  resolveStageForCase,
  resolveUniqueStageForStatus,
} from '../queues/queue-stage-defaults'
import {
  isQueueWorkflowType,
  type QueueWorkflowType,
} from '../queues/queue-workflow'
import {
  notifyAssignment,
  notifyOnComment,
} from '../notifications/notifications.service'
import { sendEmail } from '../email/email.service'
import { DocumentResubmissionEmail } from '../email/templates/document-resubmission'
import { AgreementEmail } from '../email/templates/agreement'
import { MidCreationEmail } from '../email/templates/mid-creation'
import { LiveActivationEmail } from '../email/templates/live-activation'
import {
  defaultPaymentMethodSettings,
  defaultPayoutMethodSettings,
  getConfiguredAgreementDraftForMerchantType,
  getEmailSendingModeSettings,
  getLimitsAndMdrSettings,
  getLinkDeadlineSettings,
  getMerchantPortalSettings,
  getPaymentMethodSettings,
  getPayoutMethodSettings,
} from '../configuration/configuration.service'
import { paymentMethodSettingsSchema } from '../configuration/configuration.schemas'
import type { PaymentMethodSettings } from '../configuration/configuration.schemas'
import {
  assertCreationRequirementsSatisfied,
  triggerCasesAfterSuccessfulClose,
} from './case-flow.service'
import { getRequiredDocumentTypes } from '../merchants/merchants.schemas'
import type { MerchantDocumentType } from '../merchants/merchants.schemas'
import {
  PRIVATE_INTERNAL_CASE_FILES_PATH,
  PRIVATE_KYC_APPROVED_PATH,
  PRIVATE_KYC_REJECTED_PATH,
  PUBLIC_AGREEMENT_PATH,
  buildCaseFolderName,
  ensureMerchantFolderPath,
  getRejectedRoundFolderName,
} from '../merchants/merchant-drive-folders'
import {
  DOCUMENT_TYPE_LABELS,
  MERCHANT_FIELD_LABELS,
  getDocumentIdFromFieldName,
  isDocumentFieldName,
} from './field-labels'
import { issueToken } from './case-resubmission-tokens.service'
import { caseStatusValues, isValidStatusTransition } from './cases.schemas'
import type {
  CaseStatusValue,
  CloseUnsuccessfulInput,
  CreateCaseInput,
  CreateCommentInput,
  ListCasesQuery,
  MarkLiveLimitsAppliedInput,
  MarkTestingLimitsAppliedInput,
  MerchantPortalRole,
  SaveDocumentReviewSubMerchantInput,
  SaveFieldReviewsInput,
  SaveMidCreationDetailsInput,
  SaveWordpressWebsiteInput,
  SelectSubMerchantFormInput,
  SendAgreementEmailInput,
  SendLiveEmailInput,
  SendMidCreationEmailInput,
  EmailRecipientType,
  UpdateCaseStatusInput,
} from './cases.schemas'
import {
  AGREEMENT_RECEIVED_FILE_KIND,
  AGREEMENT_FINAL_FILE_KIND,
} from './agreement.config'
import {
  SUB_MERCHANT_EMAIL_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_KIND,
} from './sub-merchant-form.config'
import { isCaseSlaBreached } from './case-sla'
import {
  assertCanViewCase,
  assertCanWorkCase,
  assertOwnerCanWorkCases,
  getAgentQueueAccess,
} from './case-access.service'
import {
  loadQueueStageForCase,
  transitionCaseState,
} from './case-transition.service'

import type { DbTransaction } from './case-db'
import {
  AGREEMENT_EMAIL_PROOF_KIND,
  AGREEMENT_FILE_EXTENSIONS,
  AGREEMENT_FILE_MIME_TYPES,
  AGREEMENT_WHATSAPP_PROOF_KIND,
  DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS,
  EMAIL_PROOF_MIME_TYPES,
  LIVE_ACTIVATION_EMAIL_PROOF_KIND,
  LIVE_ACTIVATION_WHATSAPP_PROOF_KIND,
  MAX_PHYSICAL_AGREEMENT_BYTES,
  MAX_SUB_MERCHANT_FINAL_FORM_BYTES,
  MAX_WORDPRESS_SCREENSHOT_BYTES,
  MID_CREATION_CREDENTIALS_SENT_ACTIONS,
  MID_CREATION_EMAIL_PROOF_KIND,
  MID_CREATION_WHATSAPP_PROOF_KIND,
  PHYSICAL_AGREEMENT_EXTENSIONS,
  PHYSICAL_AGREEMENT_FILE_KIND,
  PHYSICAL_AGREEMENT_MIME_TYPES,
  RESUBMISSION_EMAIL_PROOF_KIND,
  RESUBMISSION_WHATSAPP_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_EXTENSIONS,
  SUB_MERCHANT_FINAL_FORM_MIME_TYPES,
  WORDPRESS_SCREENSHOT_EXTENSIONS,
  WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX,
  WORDPRESS_SCREENSHOT_MIME_TYPES,
  WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX,
  caseStatusValueSet,
  type ManualCommunicationChannel,
} from './case-constants'
import { generatePublicTokenString } from './case-public-token'
import {
  assertInternalPortalMidLimitsApplied,
  assertTestingLimitsAppliedForCredentials,
  buildPortalPassword,
  ensureInheritedSubMerchantFormDetails,
  getCaseDetailMerchant,
  getClientPayoutRateLabel,
  getDocumentReviewDetails,
  getDocumentReviewResubmissionSentEntry,
  getInternalPortalMidLimitsAppliedEntryForMerchant,
  getLatestDocumentReviewDetailsForMerchant,
  getLatestWordpressWebsiteDetailsForMerchant,
  getLiveLimitsAppliedEntry,
  getMidCreationCredentials,
  getMidCreationCredentialsSentEntry,
  getMidCreationPortalMid,
  getPortalMidLimitApplication,
  getPayoutMethodsForMerchantRole,
  getSubMerchantFormDetails,
  getTestingLimitsAppliedEntry,
  getTestingLimitsAppliedEntryForMerchant,
  getWordpressWebsiteDetails,
  isMerchantPortalRole,
  normalizeMethodLabel,
  parseLegacyMethodSettings,
  tokenMatchesGoLiveAvailability,
  type MidCreationCredentials,
  DEFAULT_MERCHANT_PORTAL_ROLE,
  ROLE_PAYOUT_METHOD_LABELS,
} from './case-detail-lookups'
import {
  assertAutoEmailEnabled,
  assertManualEmailEnabled,
  buildAgreementEmailBody,
  buildLiveActivationEmailBody,
  buildMidCreationEmailBody,
  buildMidCreationMessageBody,
  buildResubmissionEmailBody,
  formatEmailDateTime,
  formatExpiryDate,
  formatExpiryLine,
  getRejectionLabel,
  resolveMerchantEmailRecipient,
  uploadEmailProofFile,
} from './case-communication-helpers'
import {
  getFileExtension,
  validateAgreementFile,
  validateEmailProofFile,
  validatePhysicalAgreementFile,
  validateReceivedAgreementFile,
  validateSubMerchantFinalFormFile,
  validateWordpressScreenshotFile,
} from './case-upload-validation'
import {
  ensurePrivateInternalCaseFolder,
  ensurePublicFinalAgreementFolder,
} from './case-drive-folders'
import { getCaseFileStorage } from './case-storage'
import { generateCaseNumber } from './case-number'

export type AgreementEmailResult = {
  status: 'sent' | 'failed'
  emailLogId: string
  error?: string
}

export async function loadAgreementCase(
  caseId: string,
  userId: string,
  options: { allowAwaitingClient?: boolean } = {},
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
    !(options.allowAwaitingClient && row.status === 'awaiting_client')
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
      eq(queueStages.slug, 'awaiting_client'),
    ),
  })
  if (!awaitingStage) {
    throw new AppError(
      500,
      'No awaiting_client stage configured for this queue.',
    )
  }

  const [reservedCase] = await db
    .update(cases)
    .set({
      status: 'awaiting_client',
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
    subject: `AssanPay Agreement for ${caseRow.merchantName}`,
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
    allowAwaitingClient: true,
  })
  if (caseRow.status !== 'awaiting_client') {
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
      .where(and(eq(cases.id, caseId), eq(cases.status, 'awaiting_client')))

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
