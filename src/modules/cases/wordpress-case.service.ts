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
  WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX,
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

export async function loadWordpressWebsiteCase(caseId: string, userId: string) {
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
      businessWebsite: merchants.businessWebsite,
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

  if (!row) {
    throw new AppError(404, 'Case not found.')
  }

  if (row.workflowType !== 'wordpress') {
    throw new AppError(
      400,
      'This action is only available for WordPress Website cases.',
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

export async function saveWordpressWebsiteCase(
  caseId: string,
  userId: string,
  input: SaveWordpressWebsiteInput & {
    screenshots: File[]
    subMerchantLogoScreenshots: Array<{
      subMerchantId: string
      file: File
    }>
    assanpayCheckoutScreenshots: File[]
  },
) {
  const db = getDb()
  const caseRow = await loadWordpressWebsiteCase(caseId, userId)

  if (input.screenshots.length === 0) {
    throw new AppError(400, 'At least one page screenshot is required.')
  }

  if (input.subMerchantLogoScreenshots.length === 0) {
    throw new AppError(
      400,
      'At least one sub-merchant website logo screenshot is required.',
    )
  }

  if (input.assanpayCheckoutScreenshots.length === 0) {
    throw new AppError(400, 'An AssanPay checkout page screenshot is required.')
  }

  if (input.screenshots.length > 30) {
    throw new AppError(400, 'Upload no more than 30 page screenshots.')
  }

  if (input.subMerchantLogoScreenshots.length > 30) {
    throw new AppError(
      400,
      'Upload no more than 30 sub-merchant logo screenshots.',
    )
  }

  if (input.assanpayCheckoutScreenshots.length > 1) {
    throw new AppError(
      400,
      'Upload only one AssanPay checkout page screenshot.',
    )
  }

  for (const screenshot of input.screenshots) {
    await validateWordpressScreenshotFile(screenshot)
  }
  const documentReview = await getLatestDocumentReviewDetailsForMerchant(
    caseRow.merchantId,
  )
  const selectedSubMerchants = documentReview?.subMerchants ?? []
  const selectedSubMerchantIds = new Set(
    selectedSubMerchants.map((item) => item.id),
  )
  const submittedSubMerchantIds = input.subMerchantLogoScreenshots.map(
    (item) => item.subMerchantId,
  )

  if (
    selectedSubMerchants.length === 0 ||
    submittedSubMerchantIds.length !== selectedSubMerchantIds.size ||
    new Set(submittedSubMerchantIds).size !== submittedSubMerchantIds.length ||
    submittedSubMerchantIds.some((id) => !selectedSubMerchantIds.has(id))
  ) {
    throw new AppError(
      400,
      'Upload exactly one website logo screenshot for each selected sub-merchant.',
    )
  }

  for (const screenshot of input.subMerchantLogoScreenshots) {
    await validateWordpressScreenshotFile(screenshot.file)
  }
  for (const screenshot of input.assanpayCheckoutScreenshots) {
    await validateWordpressScreenshotFile(screenshot)
  }

  const existingFiles = await db
    .select()
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.caseId, caseId),
        ilike(caseFiles.fileKind, `${WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX}%`),
      ),
    )

  const existingLogoFiles = await db
    .select()
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.caseId, caseId),
        ilike(
          caseFiles.fileKind,
          `${WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX}%`,
        ),
      ),
    )

  const existingCheckoutFiles = await db
    .select()
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.caseId, caseId),
        ilike(
          caseFiles.fileKind,
          `${WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX}%`,
        ),
      ),
    )

  const storage = getCaseFileStorage()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'WordPress Screenshots',
    storage,
  })

  const uploadedScreenshots = await Promise.all(
    input.screenshots.map((file, index) =>
      storage
        .uploadFile(folder.folderId, {
          fileName: `wordpress-page-${String(index + 1).padStart(2, '0')}-${file.name}`,
          mimeType: file.type,
          file,
        })
        .then((uploaded) => ({ file, uploaded, index })),
    ),
  )
  const uploadedLogoScreenshots = await Promise.all(
    input.subMerchantLogoScreenshots.map(({ file, subMerchantId }) =>
      storage
        .uploadFile(folder.folderId, {
          fileName: `sub-merchant-logo-${subMerchantId}-${file.name}`,
          mimeType: file.type,
          file,
        })
        .then((uploaded) => ({ file, uploaded, subMerchantId })),
    ),
  )
  const uploadedCheckoutScreenshots = await Promise.all(
    input.assanpayCheckoutScreenshots.map((file, index) =>
      storage
        .uploadFile(folder.folderId, {
          fileName: `assanpay-checkout-${String(index + 1).padStart(2, '0')}-${file.name}`,
          mimeType: file.type,
          file,
        })
        .then((uploaded) => ({ file, uploaded, index })),
    ),
  )

  const now = new Date()
  const saved = await db.transaction(async (tx) => {
    const savedFiles: Array<typeof caseFiles.$inferSelect> = []
    const savedLogoFiles: Array<typeof caseFiles.$inferSelect> = []
    const savedCheckoutFiles: Array<typeof caseFiles.$inferSelect> = []

    for (const { file, uploaded, index } of uploadedScreenshots) {
      const [savedFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: `${WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX}${String(index + 1).padStart(2, '0')}`,
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

      if (!savedFile) {
        throw new AppError(500, 'Failed to save screenshot.')
      }

      savedFiles.push(savedFile)
    }

    for (const { file, uploaded, subMerchantId } of uploadedLogoScreenshots) {
      const [savedFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: `${WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX}${subMerchantId}`,
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

      if (!savedFile) {
        throw new AppError(500, 'Failed to save sub-merchant logo screenshot.')
      }

      savedLogoFiles.push(savedFile)
    }

    for (const { file, uploaded, index } of uploadedCheckoutScreenshots) {
      const [savedFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: `${WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX}${String(index + 1).padStart(2, '0')}`,
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

      if (!savedFile) {
        throw new AppError(500, 'Failed to save checkout page screenshot.')
      }

      savedCheckoutFiles.push(savedFile)
    }

    const keptKinds = new Set(savedFiles.map((file) => file.fileKind))
    const staleFiles = existingFiles.filter(
      (file) => !keptKinds.has(file.fileKind),
    )
    if (staleFiles.length > 0) {
      await tx.delete(caseFiles).where(
        inArray(
          caseFiles.id,
          staleFiles.map((file) => file.id),
        ),
      )
    }
    const keptLogoKinds = new Set(savedLogoFiles.map((file) => file.fileKind))
    const staleLogoFiles = existingLogoFiles.filter(
      (file) => !keptLogoKinds.has(file.fileKind),
    )
    if (staleLogoFiles.length > 0) {
      await tx.delete(caseFiles).where(
        inArray(
          caseFiles.id,
          staleLogoFiles.map((file) => file.id),
        ),
      )
    }
    const keptCheckoutKinds = new Set(
      savedCheckoutFiles.map((file) => file.fileKind),
    )
    const staleCheckoutFiles = existingCheckoutFiles.filter(
      (file) => !keptCheckoutKinds.has(file.fileKind),
    )
    if (staleCheckoutFiles.length > 0) {
      await tx.delete(caseFiles).where(
        inArray(
          caseFiles.id,
          staleCheckoutFiles.map((file) => file.id),
        ),
      )
    }

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'wordpress_website_saved',
      details: {
        businessWebsite: caseRow.businessWebsite,
        clonedWebsiteLink: input.clonedWebsiteLink,
        screenshots: savedFiles.length,
        subMerchantLogoScreenshots: savedLogoFiles.length,
        assanpayCheckoutScreenshots: savedCheckoutFiles.length,
      },
      createdAt: now,
    })

    return {
      clonedWebsiteLink: input.clonedWebsiteLink,
      savedAt: now.toISOString(),
      screenshots: savedFiles,
      subMerchantLogoScreenshots: savedLogoFiles,
      assanpayCheckoutScreenshots: savedCheckoutFiles,
    }
  })

  const replacedFileIds = new Set(
    [
      ...uploadedScreenshots,
      ...uploadedLogoScreenshots,
      ...uploadedCheckoutScreenshots,
    ].map(({ uploaded }) => uploaded.fileId),
  )
  const supersededIds = [
    ...existingFiles,
    ...existingLogoFiles,
    ...existingCheckoutFiles,
  ]
    .map((oldFile) => oldFile.googleDriveFileId)
    .filter((fileId) => !replacedFileIds.has(fileId))
  await supersedeStorageObjects(supersededIds)

  return saved
}
