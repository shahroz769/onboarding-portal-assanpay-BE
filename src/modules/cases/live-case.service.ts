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
import type { MidCreationEmailResult } from './mid-case.service'

export async function markLiveLimitsApplied(
  caseId: string,
  userId: string,
  input: MarkLiveLimitsAppliedInput,
) {
  const db = getDb()
  void input

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

  if (caseRow.workflowType !== 'live') {
    throw new AppError(400, 'This action is only available for Live cases.')
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await loadQueueStageForCase(db, caseRow.currentStageId, caseRow.queueId)
    : null

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Live limits can only be confirmed in an in-progress stage.',
    )
  }

  const existingEntry = await getLiveLimitsAppliedEntry(caseId)
  if (existingEntry) {
    return {
      limitsAppliedAt: existingEntry.createdAt.toISOString(),
      limitsAppliedBy: existingEntry.actorId
        ? {
            id: existingEntry.actorId,
            name: existingEntry.actorName ?? 'Unknown',
          }
        : null,
    }
  }

  const now = new Date()
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'live_limits_applied',
    details: {
      collection: '100-50,000',
      disbursement: '1000-50,000',
    },
    createdAt: now,
  })

  const actor = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  })

  return {
    limitsAppliedAt: now.toISOString(),
    limitsAppliedBy: {
      id: userId,
      name: actor?.name ?? 'Unknown',
    },
  }
}

export async function loadLiveCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
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
  if (row.workflowType !== 'live') {
    throw new AppError(400, 'This action is only available for Live cases.')
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can send the live email.')
  }
  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function sendLiveActivationEmail(
  caseId: string,
  userId: string,
  input: SendLiveEmailInput,
): Promise<MidCreationEmailResult> {
  await assertAutoEmailEnabled()
  const db = getDb()
  const caseRow = await loadLiveCase(caseId, userId)
  const credentials = await getMidCreationCredentials(caseRow.merchantId)
  const [limitsAndMdr, merchantPortal] = await Promise.all([
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  const emailResult = await sendEmail({
    to: recipient.email,
    subject: `AssanPay account is live for ${caseRow.merchantName}`,
    template: 'live-activation',
    react: LiveActivationEmail({
      merchantName: caseRow.merchantName,
      merchantPortalUrl: merchantPortal.loginUrl,
      paymentMethods: credentials?.paymentMethods ?? [],
      payoutMethods: credentials?.payoutMethods ?? [],
      liveLimits: limitsAndMdr.live,
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `live-activation/${caseId}`,
    metadata: {
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      merchantPortalUrl: merchantPortal.loginUrl,
      liveLimits: limitsAndMdr.live,
      paymentMethods: credentials?.paymentMethods ?? [],
      payoutMethods: credentials?.payoutMethods ?? [],
    },
  })

  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action:
      emailResult.status === 'sent'
        ? 'live_activation_email_sent'
        : 'live_activation_email_failed',
    details: {
      emailLogId: emailResult.emailLogId,
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
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
