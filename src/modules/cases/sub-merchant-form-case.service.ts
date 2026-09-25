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
  AGREEMENT_CLIENT_FILE_KIND,
  AGREEMENT_FINAL_FILE_KIND
} from './agreement.config'
import {
  SUB_MERCHANT_EMAIL_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_KIND
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
  getFileExtension,
  validateAgreementFile,
  validateEmailProofFile,
  validatePhysicalAgreementFile,
  validateSubMerchantFinalFormFile,
  validateWordpressScreenshotFile,
} from './case-upload-validation'
import {
  ensurePrivateInternalCaseFolder,
  ensurePublicFinalAgreementFolder,
} from './case-drive-folders'
import { getCaseFileStorage } from './case-storage'

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
        emailStatus: 'not_sent',
        emailLogId: null,
        emailSentAt: null,
        emailRecipient: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subMerchantFormDetails.caseId,
        set: {
          subMerchantKey: subMerchant.id,
          subMerchantName: subMerchant.name,
          draftUrl: subMerchant.googleDriveWebViewLink,
          emailStatus: 'not_sent',
          emailLogId: null,
          emailSentAt: null,
          emailRecipient: null,
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

  const storage = getCaseFileStorage()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'Sub-Merchant Final Form',
    storage,
  })
  const uploaded = await storage.uploadFile(folder.folderId, {
    fileName: file.name,
    mimeType: file.type,
    file,
  })

  const now = new Date()
  const [savedFile] = await db.transaction(async (tx) => {
    await tx
      .insert(subMerchantFormDetails)
      .values({
        caseId,
        subMerchantKey: details.subMerchantKey,
        subMerchantName: details.subMerchantName,
        draftUrl: details.draftUrl,
        emailStatus: 'not_sent',
        emailLogId: null,
        emailSentAt: null,
        emailRecipient: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subMerchantFormDetails.caseId,
        set: {
          subMerchantKey: details.subMerchantKey,
          subMerchantName: details.subMerchantName,
          draftUrl: details.draftUrl,
          emailStatus: 'not_sent',
          emailLogId: null,
          emailSentAt: null,
          emailRecipient: null,
          updatedAt: now,
        },
      })

    const [caseFile] = await tx
      .insert(caseFiles)
      .values({
        caseId,
        fileKind: SUB_MERCHANT_FINAL_FORM_KIND,
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
      throw new AppError(500, 'Failed to save Final Form.')
    }

    await tx
      .update(subMerchantFormDetails)
      .set({
        finalFormFileId: caseFile.id,
        emailStatus: 'not_sent',
        emailLogId: null,
        emailSentAt: null,
        emailRecipient: null,
        updatedAt: now,
      })
      .where(eq(subMerchantFormDetails.caseId, caseId))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'sub_merchant_final_form_uploaded',
      details: {
        fileName: file.name,
        sizeBytes: uploaded.sizeBytes,
        subMerchantName: details.subMerchantName,
      },
    })

    return [caseFile]
  })

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

  const storage = getCaseFileStorage()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'Email Proofs',
    storage,
  })
  const uploaded = await storage.uploadFile(folder.folderId, {
    fileName: file.name,
    mimeType: file.type,
    file,
  })

  const now = new Date()
  const [savedFile] = await db.transaction(async (tx) => {
    const [caseFile] = await tx
      .insert(caseFiles)
      .values({
        caseId,
        fileKind: SUB_MERCHANT_EMAIL_PROOF_KIND,
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
      throw new AppError(500, 'Failed to save email proof.')
    }

    await tx
      .update(subMerchantFormDetails)
      .set({
        emailStatus: 'sent',
        emailSentAt: now,
        emailRecipient: 'Manual Gmail',
        updatedAt: now,
      })
      .where(eq(subMerchantFormDetails.caseId, caseId))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'sub_merchant_manual_email_proof_uploaded',
      details: {
        fileName: file.name,
        sizeBytes: uploaded.sizeBytes,
        subMerchantName: details.subMerchantName,
      },
      createdAt: now,
    })

    return [caseFile]
  })

  if (existingFile && existingFile.googleDriveFileId !== uploaded.fileId) {
    await supersedeStorageObjects([existingFile.googleDriveFileId])
  }

  return savedFile
}

// ─── Apply Resubmission (called from public route) ──────────────────────────
