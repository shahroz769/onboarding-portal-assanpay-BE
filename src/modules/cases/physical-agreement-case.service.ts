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
import { generateCaseNumber } from './case-number'

export async function loadPhysicalAgreementCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
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
  if (row.workflowType !== 'physical_agreement') {
    throw new AppError(
      400,
      'This action is only available for Physical Agreement cases.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(
      403,
      'Only the case owner can upload the agreement copy.',
    )
  }
  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function ensurePhysicalAgreementCaseForMerchant(
  tx: DbTransaction,
  input: { merchantId: string; parentCaseId: string; sourceQueueId: string },
) {
  const queue = await tx.query.queues.findFirst({
    where: eq(queues.workflowType, 'physical_agreement'),
    columns: {
      id: true,
      name: true,
      slug: true,
      workflowType: true,
      lifecycle: true,
      qcEnabled: true,
      isActive: true,
    },
  })
  if (!queue) {
    throw new AppError(500, 'Physical Agreement queue is not configured.')
  }
  if (queue.lifecycle !== 'active') {
    throw new AppError(409, 'Physical Agreement queue is inactive.')
  }

  const existing = await tx.query.cases.findFirst({
    where: and(
      eq(cases.merchantId, input.merchantId),
      eq(cases.queueId, queue.id),
    ),
    columns: { id: true, caseNumber: true },
  })
  if (existing) return existing

  await assertCreationRequirementsSatisfied(tx, {
    merchantId: input.merchantId,
    targetQueueId: queue.id,
  })

  const stages = await ensureQueueStages(tx, {
    id: queue.id,
    name: queue.name,
    slug: queue.slug,
    qcEnabled: queue.qcEnabled,
    workflowType: queue.workflowType,
  })
  const initialStage = stages[0]
  if (!initialStage) {
    throw new AppError(
      500,
      'No initial stage configured for Physical Agreement queue.',
    )
  }

  const merchant = await tx.query.merchants.findFirst({
    where: eq(merchants.id, input.merchantId),
    columns: { businessName: true, priority: true },
  })
  if (!merchant) throw new AppError(404, 'Merchant not found.')

  const now = new Date()
  const caseNumber = await generateCaseNumber(tx, queue.id)
  const [created] = await tx
    .insert(cases)
    .values({
      caseNumber,
      queueId: queue.id,
      merchantId: input.merchantId,
      ownerId: null,
      currentStageId: initialStage.id,
      status: 'new',
      priority: merchant.priority,
      updatedAt: now,
    })
    .returning({ id: cases.id, caseNumber: cases.caseNumber })

  if (!created) {
    throw new AppError(500, 'Failed to create Physical Agreement case.')
  }

  const [sourceCase] = await tx
    .select({
      caseNumber: cases.caseNumber,
      queueName: queues.name,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, input.parentCaseId))
    .limit(1)

  await tx.insert(caseHistory).values({
    caseId: created.id,
    actorId: null,
    action: 'case_created_from_mid_go_live_email',
    details: {
      parentCaseId: input.parentCaseId,
      sourceQueueId: input.sourceQueueId,
      sourceCaseNumber: sourceCase?.caseNumber ?? null,
      sourceQueueName: sourceCase?.queueName ?? null,
      targetQueueId: queue.id,
      targetQueueName: queue.name,
      merchantName: merchant.businessName,
    },
  })

  await tx.insert(caseLinks).values({
    parentCaseId: input.parentCaseId,
    childCaseId: created.id,
    merchantId: input.merchantId,
    triggerType: 'case_close',
    sourceQueueId: input.sourceQueueId,
    targetQueueId: queue.id,
  })

  return created
}

export async function uploadPhysicalAgreementCopy(
  caseId: string,
  userId: string,
  input: { file: File },
) {
  const db = getDb()
  const caseRow = await loadPhysicalAgreementCase(caseId, userId)
  const file = input.file
  await validatePhysicalAgreementFile(file)

  const existingFile = await db.query.caseFiles.findFirst({
    where: and(
      eq(caseFiles.caseId, caseId),
      eq(caseFiles.fileKind, PHYSICAL_AGREEMENT_FILE_KIND),
    ),
  })

  const storage = getCaseFileStorage()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'Physical Agreement',
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
        fileKind: PHYSICAL_AGREEMENT_FILE_KIND,
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
      throw new AppError(500, 'Failed to save physical agreement copy.')
    }

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'physical_agreement_uploaded',
      details: { fileName: file.name, sizeBytes: uploaded.sizeBytes },
    })

    return [caseFile]
  })

  if (existingFile && existingFile.googleDriveFileId !== uploaded.fileId) {
    await supersedeStorageObjects([existingFile.googleDriveFileId])
  }

  return savedFile
}
