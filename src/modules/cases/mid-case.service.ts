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
  queueStages,
  subMerchantFormDetails,
  subMerchantDraftTemplates,
  users,
} from '../../db/schema'
import type { Merchant } from '../../db/schema'
import { AppError } from '../../lib/errors'
import type { SessionUser } from '../../types/auth'
import { assertFileContentSignature } from '../../lib/storage/file-signatures'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import { supersedeStorageObjects } from '../../lib/storage/ownership'
import {
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
  getMerchantPortalSettings,
  getPaymentMethodSettings,
  getPayoutMethodSettings,
} from '../configuration/configuration.service'
import { paymentMethodSettingsSchema } from '../configuration/configuration.schemas'
import type { PaymentMethodSettings } from '../configuration/configuration.schemas'
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
  AGREEMENT_FINAL_FILE_KIND,
} from './agreement.config'
import {
  SUB_MERCHANT_EMAIL_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_KIND,
} from './sub-merchant-form.config'
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
  formatExpiryDate,
  formatExpiryLine,
  getMerchantIntegrationGuideLabel,
  getRejectionLabel,
  resolveCustomWebsiteServerIntegration,
  resolveMerchantEmailRecipient,
  uploadEmailProofFile,
} from './case-communication-helpers'
import {
  ensurePrivateInternalCaseFolder,
  ensurePublicFinalAgreementFolder,
} from './case-drive-folders'
import { getCaseFileStorage } from './case-storage'
import {
  getFileExtension,
  validateAgreementFile,
  validateEmailProofFile,
  validatePhysicalAgreementFile,
  validateSubMerchantFinalFormFile,
  validateWordpressScreenshotFile,
} from './case-upload-validation'
import { generateCaseNumber } from './case-number'

export async function saveMidCreationDetails(
  caseId: string,
  userId: string,
  input: SaveMidCreationDetailsInput,
) {
  const db = getDb()
  const [caseRow] = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      status: cases.status,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.workflowType !== 'mid') {
    throw new AppError(
      400,
      'This action is only available for MID Creation cases.',
    )
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can save MID details.')
  }
  await assertCanWorkCase(caseId, userId)

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await loadQueueStageForCase(db, caseRow.currentStageId, caseRow.queueId)
    : null

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(400, 'MID details can only be saved in working.')
  }

  const configuredPayoutMethods = await getPayoutMethodsForMerchantRole(
    input.merchantRole,
  )
  const payoutMethods = configuredPayoutMethods.map((method) => {
    const submittedMethod = input.payoutMethods.find(
      (submitted) => submitted.id === method.id,
    )
    return submittedMethod
      ? { ...method, commissionRate: submittedMethod.commissionRate }
      : method
  })
  const savedAt = new Date()
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'mid_creation_saved',
    details: {
      portalMid: input.portalMid,
      internalPortalMid: input.internalPortalMid,
      email: input.email,
      branchCode: input.branchCode,
      internalEmail: input.internalEmail,
      internalBranchCode: input.internalBranchCode,
      merchantRole: input.merchantRole,
      paymentMethods: input.paymentMethods,
      payoutMethods,
    },
    createdAt: savedAt,
  })

  return {
    portalMid: input.portalMid,
    internalPortalMid: input.internalPortalMid,
    email: input.email,
    branchCode: input.branchCode,
    internalEmail: input.internalEmail,
    internalBranchCode: input.internalBranchCode,
    merchantRole: input.merchantRole,
    paymentMethods: input.paymentMethods,
    payoutMethods,
    savedAt: savedAt.toISOString(),
  }
}

export type MidCreationEmailResult = {
  status: 'sent' | 'failed'
  emailLogId: string
  error?: string
}

export async function loadMidCreationCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      merchantNumber: merchants.merchantNumber,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
      websiteCms: merchants.websiteCms,
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
  if (row.workflowType !== 'testing') {
    throw new AppError(400, 'This action is only available for Testing cases.')
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can send credentials.')
  }
  await assertCanWorkCase(caseId, userId)
  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function sendMidCreationCredentialsEmail(
  caseId: string,
  userId: string,
  input: SendMidCreationEmailInput,
): Promise<MidCreationEmailResult> {
  await assertAutoEmailEnabled()
  const db = getDb()
  const caseRow = await loadMidCreationCase(caseId, userId)
  const credentials = await getMidCreationCredentials(caseRow.merchantId)
  if (!credentials) {
    throw new AppError(
      400,
      'Save the merchant portal credentials in MID Creation before sending credentials.',
    )
  }
  await assertTestingLimitsAppliedForCredentials(credentials)
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  const [limitsAndMdr, merchantPortal] = await Promise.all([
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])
  const portalPassword = buildPortalPassword(
    credentials.email,
    caseRow.merchantNumber,
  )
  const payoutRateLabel = getClientPayoutRateLabel(credentials.merchantRole)
  const serverIntegration = resolveCustomWebsiteServerIntegration(
    caseRow.websiteCms,
    merchantPortal,
  )
  const communicationId = crypto.randomUUID()

  const emailResult = await sendEmail({
    to: recipient.email,
    subject: `AssanPay merchant portal credentials for ${caseRow.merchantName}`,
    template: 'mid-creation',
    react: MidCreationEmail({
      merchantName: caseRow.merchantName,
      portalEmail: credentials.email,
      portalPassword,
      merchantPortalUrl: merchantPortal.loginUrl,
      integrationGuideLabel: getMerchantIntegrationGuideLabel(
        caseRow.websiteCms,
      ),
      serverIntegration,
      paymentMethods: credentials.paymentMethods,
      payoutMethods: credentials.payoutMethods,
      testingLimits: limitsAndMdr.testing,
      rates: {
        payout: limitsAndMdr.rates.payout,
        payoutLabel: payoutRateLabel,
      },
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `mid-creation/${caseId}/${communicationId}`,
    metadata: {
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      portalEmail: credentials.email,
      portalMid: credentials.portalMid,
      websiteCms: caseRow.websiteCms,
      paymentMethods: credentials.paymentMethods,
      payoutMethods: credentials.payoutMethods,
      limitsAndMdr,
      merchantPortalUrl: merchantPortal.loginUrl,
      serverIntegration,
    },
  })

  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action:
      emailResult.status === 'sent'
        ? 'mid_creation_email_sent'
        : 'mid_creation_email_failed',
    details: {
      emailLogId: emailResult.emailLogId,
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      portalMid: credentials.portalMid,
      error: emailResult.error ?? null,
    },
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
