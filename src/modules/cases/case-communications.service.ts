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
import { loadAgreementCase } from './agreement-case.service'
import { generatePublicTokenString } from './case-public-token'
import { loadLiveCase } from './live-case.service'
import { loadMidCreationCase } from './mid-case.service'
import { ensurePhysicalAgreementCaseForMerchant } from './physical-agreement-case.service'

export type ResubmissionEmailPreviewResult = {
  recipient: string
  subject: string
  body: string
  tokenId: string
  tokenExpiresAt: string
}

export async function getResubmissionEmailPreview(
  caseId: string,
  userId: string,
  input: { recipientEmailType?: EmailRecipientType } = {},
): Promise<ResubmissionEmailPreviewResult> {
  await assertManualEmailEnabled()
  const db = getDb()

  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
      merchantWhatsappNumber: merchants.activeWhatsappNumber,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.workflowType !== 'document_review') {
    throw new AppError(
      400,
      'Resubmission is only available for documents-review cases.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can send for resubmission.')
  }
  if (row.status !== 'working' && row.status !== 'awaiting_client') {
    throw new AppError(
      400,
      'The case must be in the working or awaiting-client stage to send for resubmission.',
    )
  }
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: row.merchantSubmitterEmail,
      businessEmail: row.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  const rejectedReviews = await db
    .select({
      fieldName: caseFieldReviews.fieldName,
      remarks: caseFieldReviews.remarks,
    })
    .from(caseFieldReviews)
    .where(
      and(
        eq(caseFieldReviews.caseId, caseId),
        eq(caseFieldReviews.status, 'rejected'),
      ),
    )

  if (rejectedReviews.length === 0) {
    throw new AppError(
      400,
      'There are no rejected fields to send for resubmission.',
    )
  }

  const docIds = rejectedReviews
    .map((r) => getDocumentIdFromFieldName(r.fieldName))
    .filter((id): id is string => id !== null)
  const documentTypeById = new Map<string, string>()
  if (docIds.length > 0) {
    const docs = await db
      .select({
        id: merchantDocuments.id,
        documentType: merchantDocuments.documentType,
      })
      .from(merchantDocuments)
      .where(inArray(merchantDocuments.id, docIds))
    for (const d of docs) documentTypeById.set(d.id, d.documentType)
  }

  const rejections = rejectedReviews.map((review) => ({
    label: getRejectionLabel(review.fieldName, documentTypeById),
    remarks: review.remarks,
  }))

  // Reuse an unconsumed pending token for this case if it exists
  const linkDeadlines = await getLinkDeadlineSettings()
  const minExpiry = new Date(Date.now() + 60 * 60 * 1000) // must be valid for at least 1h
  const existingToken = await db.query.caseResubmissionTokens.findFirst({
    where: and(
      eq(caseResubmissionTokens.caseId, caseId),
      isNull(caseResubmissionTokens.consumedAt),
      gt(caseResubmissionTokens.expiresAt, minExpiry),
    ),
    orderBy: [desc(caseResubmissionTokens.createdAt)],
  })

  const issued = existingToken?.token
    ? {
        token: existingToken.token,
        tokenId: existingToken.id,
        expiresAt: existingToken.expiresAt,
      }
    : await issueToken(
        caseId,
        userId,
        linkDeadlines.documentsReviewResubmissionHours,
      )

  const resubmissionUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/resubmit/${issued.token}`
  const subject = 'Action required to update your onboarding submission'
  const body = buildResubmissionEmailBody({
    merchantName: row.merchantName,
    ownerName: row.merchantOwnerName,
    rejections,
    resubmissionUrl,
    expiresAt: formatExpiryDate(issued.expiresAt),
  })

  return {
    recipient: recipient.email,
    subject,
    body,
    tokenId: issued.tokenId,
    tokenExpiresAt: issued.expiresAt.toISOString(),
  }
}

export type ManualEmailResult = {
  status: 'sent'
  fileId: string
}

export async function confirmResubmissionEmailManual(
  caseId: string,
  userId: string,
  input: {
    tokenId: string
    file: File
    channel?: ManualCommunicationChannel
    recipientEmailType?: EmailRecipientType
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  await validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'

  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      queueId: cases.queueId,
      currentStageId: cases.currentStageId,
      queueName: queues.name,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
      merchantWhatsappNumber: merchants.activeWhatsappNumber,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.ownerId !== userId)
    throw new AppError(403, 'Only the case owner can confirm this.')
  if (
    row.status !== 'working' &&
    !(channel === 'whatsapp' && row.status === 'awaiting_client')
  )
    throw new AppError(400, 'The case must be in the working stage.')
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: row.merchantSubmitterEmail,
      businessEmail: row.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )
  if (channel === 'whatsapp' && !row.merchantWhatsappNumber) {
    throw new AppError(400, 'No active WhatsApp number is on file.')
  }

  const tokenRow = await db.query.caseResubmissionTokens.findFirst({
    where: and(
      eq(caseResubmissionTokens.id, input.tokenId),
      eq(caseResubmissionTokens.caseId, caseId),
      isNull(caseResubmissionTokens.consumedAt),
    ),
  })
  if (!tokenRow) throw new AppError(400, 'Invalid or expired preview token.')

  const rejectedReviews = await db
    .select({
      fieldName: caseFieldReviews.fieldName,
      remarks: caseFieldReviews.remarks,
    })
    .from(caseFieldReviews)
    .where(
      and(
        eq(caseFieldReviews.caseId, caseId),
        eq(caseFieldReviews.status, 'rejected'),
      ),
    )

  const docIds = rejectedReviews
    .map((r) => getDocumentIdFromFieldName(r.fieldName))
    .filter((id): id is string => id !== null)
  const documentTypeById = new Map<string, string>()
  if (docIds.length > 0) {
    const docs = await db
      .select({
        id: merchantDocuments.id,
        documentType: merchantDocuments.documentType,
      })
      .from(merchantDocuments)
      .where(inArray(merchantDocuments.id, docIds))
    for (const d of docs) documentTypeById.set(d.id, d.documentType)
  }
  const rejectedFieldNames = rejectedReviews.map((r) => r.fieldName)
  const rejectedFieldLabels = rejectedReviews.map((r) =>
    getRejectionLabel(r.fieldName, documentTypeById),
  )
  const rejectedFieldDetails = rejectedReviews.map((review) => ({
    fieldName: review.fieldName,
    label: getRejectionLabel(review.fieldName, documentTypeById),
    type: isDocumentFieldName(review.fieldName) ? 'document' : 'text',
    rejectionReason: review.remarks,
  }))

  const stages = await ensureQueueStages(db, {
    id: row.queueId,
    name: 'Documents Review',
    slug: row.queueSlug,
    qcEnabled: false,
    workflowType: row.workflowType ?? 'document_review',
  })
  const awaitingStage = stages.find((s) => s.slug === 'awaiting_client') ?? null
  if (!awaitingStage)
    throw new AppError(500, 'No awaiting_client stage configured.')

  if (row.status === 'working') {
    const [reservedCase] = await db
      .update(cases)
      .set({
        status: 'awaiting_client',
        currentStageId: awaitingStage.id,
        updatedAt: new Date(),
      })
      .where(and(eq(cases.id, caseId), eq(cases.status, 'working')))
      .returning({ id: cases.id })
    if (!reservedCase)
      throw new AppError(
        409,
        'This case has already been sent for resubmission.',
      )
  }

  const { savedFile } = await uploadEmailProofFile(
    caseId,
    userId,
    input.file,
    channel === 'whatsapp'
      ? RESUBMISSION_WHATSAPP_PROOF_KIND
      : RESUBMISSION_EMAIL_PROOF_KIND,
    row.caseNumber,
    row.merchantId,
    row.merchantName,
    row.queueName,
  )

  const now = new Date()
  await db.transaction(async (tx) => {
    if (row.status === 'working') {
      await tx.insert(caseHistory).values({
        caseId,
        actorId: userId,
        action: 'rejections_prepared',
        details: {
          total: rejectedFieldNames.length,
          rejected: rejectedFieldNames.length,
          approved: 0,
          rejectedFields: rejectedFieldNames,
          rejectedFieldLabels,
          rejectedFieldDetails,
        },
      })
    }
    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action:
        channel === 'whatsapp'
          ? 'resubmission_whatsapp_sent_manual'
          : 'resubmission_email_sent_manual',
      details: {
        tokenId: input.tokenId,
        expiresAt: tokenRow.expiresAt.toISOString(),
        rejectedFields: rejectedFieldNames,
        rejectedFieldLabels,
        rejectedFieldDetails,
        recipient:
          channel === 'whatsapp'
            ? row.merchantWhatsappNumber
            : recipient.email,
        emailRecipient: recipient.email,
        recipientEmailType: recipient.recipientEmailType,
        whatsappRecipient: row.merchantWhatsappNumber,
        screenshotFileId: savedFile.id,
        channel,
        manual: true,
      },
      createdAt: now,
    })
  })

  return { status: 'sent', fileId: savedFile.id }
}

// ─── Agreement email preview & manual confirm ────────────────────────────────

export type AgreementEmailPreviewResult = {
  recipient: string
  subject: string
  body: string
  tokenId: string
  tokenExpiresAt: string
}

export async function getAgreementEmailPreview(
  caseId: string,
  userId: string,
  input: {
    remarks?: string | null
    recipientEmailType?: EmailRecipientType
  } = {},
): Promise<AgreementEmailPreviewResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId, {
    allowAwaitingClient: true,
  })

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

  const remarks = input.remarks?.trim() || null
  if (details.clientAgreementFileId && !remarks) {
    throw new AppError(
      400,
      'Remarks are required when asking the client to resubmit the agreement.',
    )
  }

  const linkDeadlines = await getLinkDeadlineSettings()
  const minExpiry = new Date(Date.now() + 60 * 60 * 1000)
  const existingToken = await db.query.caseResubmissionTokens.findFirst({
    where: and(
      eq(caseResubmissionTokens.caseId, caseId),
      isNull(caseResubmissionTokens.consumedAt),
      gt(caseResubmissionTokens.expiresAt, minExpiry),
    ),
    orderBy: [desc(caseResubmissionTokens.createdAt)],
  })

  const issued = existingToken?.token
    ? {
        token: existingToken.token,
        tokenId: existingToken.id,
        expiresAt: existingToken.expiresAt,
      }
    : await issueToken(caseId, userId, linkDeadlines.agreementLinkHours)

  const agreementUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/agreement/${issued.token}`
  const subject = `Agreement for ${caseRow.merchantName}`
  const body = buildAgreementEmailBody({
    merchantName: caseRow.merchantName,
    ownerName: caseRow.merchantOwnerName,
    agreementUrl,
    expiresAt: formatExpiryDate(issued.expiresAt),
    remarks,
  })

  return {
    recipient: recipient.email,
    subject,
    body,
    tokenId: issued.tokenId,
    tokenExpiresAt: issued.expiresAt.toISOString(),
  }
}

export async function confirmAgreementEmailManual(
  caseId: string,
  userId: string,
  input: {
    tokenId: string
    remarks?: string | null
    file: File
    channel?: ManualCommunicationChannel
    recipientEmailType?: EmailRecipientType
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  await validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'

  const caseRow = await loadAgreementCase(caseId, userId, {
    allowAwaitingClient: channel === 'whatsapp',
  })
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
    throw new AppError(400, 'Upload the Final Agreement before confirming.')
  }

  const tokenRow = await db.query.caseResubmissionTokens.findFirst({
    where: and(
      eq(caseResubmissionTokens.id, input.tokenId),
      eq(caseResubmissionTokens.caseId, caseId),
      isNull(caseResubmissionTokens.consumedAt),
    ),
  })
  if (!tokenRow) throw new AppError(400, 'Invalid or expired preview token.')

  const awaitingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, 'awaiting_client'),
    ),
  })
  if (!awaitingStage)
    throw new AppError(500, 'No awaiting_client stage configured.')

  if (caseRow.status === 'working') {
    const [reservedCase] = await db
      .update(cases)
      .set({
        status: 'awaiting_client',
        currentStageId: awaitingStage.id,
        updatedAt: new Date(),
      })
      .where(and(eq(cases.id, caseId), eq(cases.status, 'working')))
      .returning({ id: cases.id })
    if (!reservedCase)
      throw new AppError(409, 'This case has already been sent to the client.')
  } else if (channel !== 'whatsapp' || caseRow.status !== 'awaiting_client') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const { savedFile } = await uploadEmailProofFile(
    caseId,
    userId,
    input.file,
    channel === 'whatsapp'
      ? AGREEMENT_WHATSAPP_PROOF_KIND
      : AGREEMENT_EMAIL_PROOF_KIND,
    caseRow.caseNumber,
    caseRow.merchantId,
    caseRow.merchantName,
    caseRow.queueName,
  )

  const remarks = input.remarks?.trim() || null
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(agreementCaseDetails)
      .set({
        emailStatus: 'sent',
        emailSentAt: now,
        emailRecipient: recipient.email,
        lastRejectionRemarks: remarks,
        updatedAt: now,
      })
      .where(eq(agreementCaseDetails.caseId, caseId))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action:
        channel === 'whatsapp'
          ? 'agreement_whatsapp_sent_manual'
          : 'agreement_email_sent_manual',
      details: {
        tokenId: input.tokenId,
        expiresAt: tokenRow.expiresAt.toISOString(),
        recipient: recipient.email,
        recipientEmailType: recipient.recipientEmailType,
        remarks,
        screenshotFileId: savedFile.id,
        channel,
        manual: true,
      },
      createdAt: now,
    })
  })

  return { status: 'sent', fileId: savedFile.id }
}

// ─── Mid-creation email preview & manual confirm ─────────────────────────────

export type MidCreationEmailPreviewResult = {
  recipient: string
  subject: string
  body: string
  tokenId: string
  goLiveAvailableAt: string
}

export async function getMidCreationEmailPreview(
  caseId: string,
  userId: string,
  _input: SendMidCreationEmailInput,
): Promise<MidCreationEmailPreviewResult> {
  await assertManualEmailEnabled()
  const caseRow = await loadMidCreationCase(caseId, userId)
  const db = getDb()

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
    _input.recipientEmailType,
  )

  const [linkDeadlines, limitsAndMdr, merchantPortal] = await Promise.all([
    getLinkDeadlineSettings(),
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])

  const now = new Date()
  const availableAt =
    linkDeadlines.goLiveAvailabilityHours == null
      ? now // immediately available when no delay configured
      : new Date(
          now.getTime() +
            linkDeadlines.goLiveAvailabilityHours * 60 * 60 * 1000,
        )

  // Reuse an unconsumed pending go-live token
  const minExpiry = new Date(Date.now() + 60 * 60 * 1000)
  const existingTokenCandidate = await db.query.midGoLiveTokens.findFirst({
    where: and(
      eq(midGoLiveTokens.caseId, caseId),
      isNull(midGoLiveTokens.consumedAt),
      gt(midGoLiveTokens.availableAt, minExpiry),
    ),
    orderBy: [desc(midGoLiveTokens.createdAt)],
  })
  const existingToken =
    existingTokenCandidate &&
    tokenMatchesGoLiveAvailability(
      existingTokenCandidate,
      linkDeadlines.goLiveAvailabilityHours,
    )
      ? existingTokenCandidate
      : null

  let tokenId: string
  let goLiveToken: string
  let resolvedAvailableAt: Date

  if (existingToken?.token) {
    tokenId = existingToken.id
    goLiveToken = existingToken.token
    resolvedAvailableAt = existingToken.availableAt
  } else {
    const token = generatePublicTokenString()
    const tokenHash = await hashToken(token)
    resolvedAvailableAt = availableAt
    const [tokenRow] = await db
      .insert(midGoLiveTokens)
      .values({
        caseId,
        token: null,
        tokenHash,
        availableAt,
        createdBy: userId,
      })
      .returning({ id: midGoLiveTokens.id })
    if (!tokenRow) throw new AppError(500, 'Failed to issue Go-Live token.')
    tokenId = tokenRow.id
    goLiveToken = token
  }

  const goLiveUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/go-live/${goLiveToken}`
  const isShopify = caseRow.websiteCms === 'shopify'
  const subject = `AssanPay merchant portal credentials for ${caseRow.merchantName}`
  const portalPassword = buildPortalPassword(credentials.email)
  const payoutRateLabel = getClientPayoutRateLabel(credentials.merchantRole)
  const body = buildMidCreationMessageBody({
    merchantName: caseRow.merchantName,
    portalEmail: credentials.email,
    portalPassword,
    merchantPortalUrl: merchantPortal.loginUrl,
    goLiveUrl,
    availableAt: formatEmailDateTime(resolvedAvailableAt),
    goLiveAvailabilityHours: linkDeadlines.goLiveAvailabilityHours,
    testingLimits: limitsAndMdr.testing,
    cardRate: isShopify
      ? `${limitsAndMdr.rates.cardShopify}%`
      : `${limitsAndMdr.rates.cardDefault}%`,
    eWalletsRate: `${limitsAndMdr.rates.eWallets}%`,
    payoutRate: `${limitsAndMdr.rates.payout}%`,
    payoutRateLabel,
  })

  return {
    recipient: recipient.email,
    subject,
    body,
    tokenId,
    goLiveAvailableAt: resolvedAvailableAt.toISOString(),
  }
}

export async function confirmMidCreationEmailManual(
  caseId: string,
  userId: string,
  input: SendMidCreationEmailInput & {
    tokenId: string
    file: File
    channel?: ManualCommunicationChannel
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  await validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'
  const caseRow = await loadMidCreationCase(caseId, userId)
  const db = getDb()

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

  const tokenRow = await db.query.midGoLiveTokens.findFirst({
    where: and(
      eq(midGoLiveTokens.id, input.tokenId),
      eq(midGoLiveTokens.caseId, caseId),
      isNull(midGoLiveTokens.consumedAt),
    ),
  })
  if (!tokenRow) throw new AppError(400, 'Invalid or expired preview token.')

  const { savedFile } = await uploadEmailProofFile(
    caseId,
    userId,
    input.file,
    channel === 'whatsapp'
      ? MID_CREATION_WHATSAPP_PROOF_KIND
      : MID_CREATION_EMAIL_PROOF_KIND,
    caseRow.caseNumber,
    caseRow.merchantId,
    caseRow.merchantName,
    caseRow.queueName,
  )

  const now = new Date()
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action:
      channel === 'whatsapp'
        ? 'mid_creation_whatsapp_sent_manual'
        : 'mid_creation_email_sent_manual',
    details: {
      tokenId: input.tokenId,
      availableAt: tokenRow.availableAt.toISOString(),
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      portalMid: credentials.portalMid,
      screenshotFileId: savedFile.id,
      channel,
      manual: true,
    },
    createdAt: now,
  })

  await db.transaction((tx) =>
    ensurePhysicalAgreementCaseForMerchant(tx, {
      merchantId: caseRow.merchantId,
      parentCaseId: caseId,
      sourceQueueId: caseRow.queueId,
    }),
  )

  return { status: 'sent', fileId: savedFile.id }
}

export type LiveActivationEmailPreviewResult = {
  recipient: string
  subject: string
  body: string
  tokenId: string
  goLiveAvailableAt: null
}

export async function getLiveActivationEmailPreview(
  caseId: string,
  userId: string,
  input: SendLiveEmailInput,
): Promise<LiveActivationEmailPreviewResult> {
  await assertManualEmailEnabled()
  const caseRow = await loadLiveCase(caseId, userId)
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
  const subject = `AssanPay account is live for ${caseRow.merchantName}`

  return {
    recipient: recipient.email,
    subject,
    body: buildLiveActivationEmailBody({
      merchantName: caseRow.merchantName,
      merchantPortalUrl: merchantPortal.loginUrl,
      liveLimits: limitsAndMdr.live,
    }),
    tokenId: caseId,
    goLiveAvailableAt: null,
  }
}

export async function confirmLiveActivationEmailManual(
  caseId: string,
  userId: string,
  input: SendLiveEmailInput & {
    tokenId: string
    file: File
    channel?: ManualCommunicationChannel
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  await validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'
  const caseRow = await loadLiveCase(caseId, userId)
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  if (input.tokenId !== caseId) {
    throw new AppError(400, 'Invalid preview token.')
  }

  const { savedFile } = await uploadEmailProofFile(
    caseId,
    userId,
    input.file,
    channel === 'whatsapp'
      ? LIVE_ACTIVATION_WHATSAPP_PROOF_KIND
      : LIVE_ACTIVATION_EMAIL_PROOF_KIND,
    caseRow.caseNumber,
    caseRow.merchantId,
    caseRow.merchantName,
    caseRow.queueName,
  )

  await getDb()
    .insert(caseHistory)
    .values({
      caseId,
      actorId: userId,
      action:
        channel === 'whatsapp'
          ? 'live_activation_whatsapp_sent_manual'
          : 'live_activation_email_sent_manual',
      details: {
        recipient: recipient.email,
        recipientEmailType: recipient.recipientEmailType,
        screenshotFileId: savedFile.id,
        channel,
        manual: true,
      },
      createdAt: new Date(),
    })

  return { status: 'sent', fileId: savedFile.id }
}
