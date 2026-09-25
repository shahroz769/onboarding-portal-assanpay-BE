import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
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
  ensurePrivateInternalCaseFolder,
  ensurePublicFinalAgreementFolder,
} from './case-drive-folders'
import { getCaseFileStorage } from './case-storage'
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
import type {
  RegeneratedResubmissionLinkResult,
  SendForResubmissionResult,
} from './case-documents-review.types'

export async function saveFieldReviews(
  caseId: string,
  userId: string,
  input: SaveFieldReviewsInput,
) {
  const db = getDb()

  // Validate case state
  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      status: cases.status,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (caseData.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can save field reviews.')
  }

  if (caseData.status === 'awaiting_client') {
    throw new AppError(
      400,
      'Rejection changes are locked while awaiting merchant resubmission.',
    )
  }

  if (caseData.status !== 'working') {
    throw new AppError(
      400,
      'Field reviews can only be saved while the case is working.',
    )
  }

  if (!caseData.currentStageId) {
    throw new AppError(400, 'Case has no current stage.')
  }

  const currentStage = await loadQueueStageForCase(
    db,
    caseData.currentStageId,
    caseData.queueId,
  )

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Field reviews can only be saved in an in-progress stage.',
    )
  }

  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, caseData.queueId),
    columns: { slug: true, workflowType: true, slaHours: true },
  })

  const now = new Date()
  const reviewByFieldName = new Map(
    input.reviews.map((review) => [review.fieldName, review]),
  )
  const reviewValues = [...reviewByFieldName.values()].map((review) => ({
    caseId,
    fieldName: review.fieldName,
    status: review.status,
    remarks: review.remarks ?? null,
    reviewedBy: userId,
    createdAt: now,
    updatedAt: now,
  }))
  const documentMoves =
    queue != null && isQueueWorkflowType(queue, 'document_review')
      ? await prepareDocumentReviewDocumentMoves({
          caseId,
          merchantId: caseData.merchantId,
          reviews: reviewValues,
        })
      : []

  await db.transaction(async (tx) => {
    await tx
      .insert(caseFieldReviews)
      .values(reviewValues)
      .onConflictDoUpdate({
        target: [caseFieldReviews.caseId, caseFieldReviews.fieldName],
        set: {
          status: sql`excluded.status`,
          remarks: sql`excluded.remarks`,
          reviewedBy: userId,
          updatedAt: now,
        },
      })

    for (const move of documentMoves) {
      await tx
        .update(merchantDocuments)
        .set({
          status: move.status,
          googleDriveWebViewLink: move.googleDriveWebViewLink,
          googleDriveDownloadLink: move.googleDriveDownloadLink,
          googleDriveFolderId: move.googleDriveFolderId,
          updatedAt: now,
        })
        .where(eq(merchantDocuments.id, move.documentId))
    }

    if (queue == null || !isQueueWorkflowType(queue, 'document_review')) {
      const rejected = reviewValues.filter(
        (r) => r.status === 'rejected',
      ).length
      const approved = reviewValues.filter(
        (r) => r.status === 'approved',
      ).length
      await tx.insert(caseHistory).values({
        caseId,
        actorId: userId,
        action: 'field_reviews_saved',
        details: { total: reviewValues.length, approved, rejected },
      })
    }
  })

  return { saved: reviewValues.length }
}

// ─── Close Unsuccessful ─────────────────────────────────────────────────────

type PreparedDocumentMove = {
  documentId: string
  status: 'approved' | 'rejected'
  googleDriveWebViewLink: string
  googleDriveDownloadLink: string | null
  googleDriveFolderId: string
}

async function prepareDocumentReviewDocumentMoves(input: {
  caseId: string
  merchantId: string
  reviews: Array<{
    fieldName: string
    status: string
  }>
}): Promise<PreparedDocumentMove[]> {
  const documentReviews = input.reviews
    .map((review) => ({
      documentId: getDocumentIdFromFieldName(review.fieldName),
      status: review.status,
    }))
    .filter(
      (
        review,
      ): review is {
        documentId: string
        status: 'approved' | 'rejected'
      } =>
        Boolean(review.documentId) &&
        (review.status === 'approved' || review.status === 'rejected'),
    )

  if (documentReviews.length === 0) return []

  const db = getDb()
  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.id, input.merchantId),
    columns: { id: true, businessName: true },
  })
  if (!merchant) throw new AppError(404, 'Merchant not found.')

  const documentIds = Array.from(
    new Set(documentReviews.map((review) => review.documentId)),
  )
  const documents = await db
    .select({
      id: merchantDocuments.id,
      googleDriveFileId: merchantDocuments.googleDriveFileId,
    })
    .from(merchantDocuments)
    .where(inArray(merchantDocuments.id, documentIds))
  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  )
  const storage = getCaseFileStorage()
  const [rejectionRoundRow] = await db
    .select({ count: count() })
    .from(caseHistory)
    .where(
      and(
        eq(caseHistory.caseId, input.caseId),
        inArray(
          caseHistory.action,
          Array.from(DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS),
        ),
      ),
    )
  const rejectedRound = Number(rejectionRoundRow?.count ?? 0) + 1
  let approvedFolderId: string | null = null
  let rejectedFolderId: string | null = null
  const moves: PreparedDocumentMove[] = []

  for (const review of documentReviews) {
    const document = documentsById.get(review.documentId)
    if (!document) continue

    if (review.status === 'approved' && !approvedFolderId) {
      const folder = await ensureMerchantFolderPath({
        merchantId: merchant.id,
        merchantName: merchant.businessName,
        visibility: 'private',
        path: [...PRIVATE_KYC_APPROVED_PATH],
        storage,
      })
      approvedFolderId = folder.folderId
    }

    if (review.status === 'rejected' && !rejectedFolderId) {
      const folder = await ensureMerchantFolderPath({
        merchantId: merchant.id,
        merchantName: merchant.businessName,
        visibility: 'private',
        path: [
          ...PRIVATE_KYC_REJECTED_PATH,
          getRejectedRoundFolderName(rejectedRound),
        ],
        storage,
      })
      rejectedFolderId = folder.folderId
    }

    const folderId =
      review.status === 'approved' ? approvedFolderId : rejectedFolderId
    if (!folderId) continue

    const moved = await storage.moveFile(document.googleDriveFileId, folderId)
    moves.push({
      documentId: review.documentId,
      status: review.status,
      googleDriveWebViewLink: moved.webViewLink,
      googleDriveDownloadLink: moved.downloadLink,
      googleDriveFolderId: moved.folderId,
    })
  }

  return moves
}

export async function saveDocumentReviewSubMerchant(
  caseId: string,
  userId: string,
  input: SaveDocumentReviewSubMerchantInput,
) {
  const db = getDb()
  const [caseRow] = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      status: cases.status,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
      caseNumber: cases.caseNumber,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.workflowType !== 'document_review') {
    throw new AppError(
      400,
      'Sub-merchant selection is only available for document review cases.',
    )
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can select sub-merchants.')
  }

  if (caseRow.status !== 'working' || !caseRow.currentStageId) {
    throw new AppError(
      400,
      'Sub-merchants can only be selected while the case is working.',
    )
  }

  const selectedIds = [...new Set(input.subMerchantIds)]
  const subMerchants = await db
    .select({
      id: subMerchantDraftTemplates.id,
      name: subMerchantDraftTemplates.name,
    })
    .from(subMerchantDraftTemplates)
    .where(inArray(subMerchantDraftTemplates.id, selectedIds))

  if (subMerchants.length !== selectedIds.length) {
    throw new AppError(400, 'One or more sub-merchant selections are invalid.')
  }

  const now = new Date()
  const details = await db.transaction(async (tx) => {
    await tx
      .delete(documentReviewDetails)
      .where(eq(documentReviewDetails.caseId, caseId))

    const inserted = await tx
      .insert(documentReviewDetails)
      .values(
        subMerchants.map((subMerchant) => ({
          caseId,
          subMerchantId: subMerchant.id,
          subMerchantName: subMerchant.name,
          selectedBy: userId,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning()

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'document_review_sub_merchant_selected',
      details: {
        subMerchantIds: subMerchants.map((item) => item.id),
        subMerchantNames: subMerchants.map((item) => item.name),
        caseNumber: caseRow.caseNumber,
      },
      createdAt: now,
    })

    return inserted
  })

  if (details.length !== subMerchants.length) {
    throw new AppError(500, 'Failed to save sub-merchant selection.')
  }

  return {
    subMerchants: details.map((item) => ({
      id: item.subMerchantId,
      name: item.subMerchantName,
    })),
    selectedAt: now.toISOString(),
  }
}

export async function sendForResubmission(
  caseId: string,
  userId: string,
  input: { recipientEmailType?: EmailRecipientType } = {},
): Promise<SendForResubmissionResult> {
  await assertAutoEmailEnabled()
  const db = getDb()

  // 1. Load case with queue/merchant info
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      status: cases.status,
      queueId: cases.queueId,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Case not found.')
  }

  if (row.workflowType !== 'document_review') {
    throw new AppError(
      400,
      'Resubmission is only available for documents-review cases.',
    )
  }

  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can send for resubmission.')
  }

  if (row.status !== 'working') {
    throw new AppError(
      400,
      'The case must be in the working stage to send for resubmission.',
    )
  }

  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: row.merchantSubmitterEmail,
      businessEmail: row.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  // 2. Load rejected field reviews
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

  // 3. Resolve labels (load document types for any doc_<id> fieldNames)
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
    for (const d of docs) {
      documentTypeById.set(d.id, d.documentType)
    }
  }

  const rejections = rejectedReviews.map((review) => ({
    label: getRejectionLabel(review.fieldName, documentTypeById),
    remarks: review.remarks,
  }))
  const rejectedFieldNames = rejectedReviews.map((r) => r.fieldName)
  const rejectedFieldLabels = rejections.map((rejection) => rejection.label)
  const rejectedFieldDetails = rejectedReviews.map((review) => ({
    fieldName: review.fieldName,
    label: getRejectionLabel(review.fieldName, documentTypeById),
    type: isDocumentFieldName(review.fieldName) ? 'document' : 'text',
    rejectionReason: review.remarks,
  }))

  // 4. Ensure queue stages are fully seeded, then resolve awaiting_client
  const stages = await ensureQueueStages(db, {
    id: row.queueId,
    name:
      row.workflowType === 'document_review' ? 'Documents Review' : row.queueSlug,
    slug: row.queueSlug,
    qcEnabled: false,
    workflowType: row.workflowType ?? 'document_review',
  })
  const awaitingStage =
    stages.find((stage) => stage.slug === 'awaiting_client') ?? null

  if (!awaitingStage) {
    throw new AppError(
      500,
      'No awaiting_client stage configured for this queue.',
    )
  }

  const reservedAt = new Date()
  const [reservedCase] = await db
    .update(cases)
    .set({
      status: 'awaiting_client',
      currentStageId: awaitingStage.id,
      updatedAt: reservedAt,
    })
    .where(and(eq(cases.id, caseId), eq(cases.status, 'working')))
    .returning({ id: cases.id })

  if (!reservedCase) {
    throw new AppError(409, 'This case has already been sent for resubmission.')
  }

  // 5. Issue token
  const linkDeadlines = await getLinkDeadlineSettings()
  const issued = await issueToken(
    caseId,
    userId,
    linkDeadlines.documentsReviewResubmissionHours,
  )

  const preparedAt = new Date()

  // 6. Send the email
  const resubmissionUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/resubmit/${issued.token}`
  const emailResult = await sendEmail({
    to: recipient.email,
    subject: 'Action required to update your onboarding submission',
    template: 'document-resubmission',
    react: DocumentResubmissionEmail({
      merchantName: row.merchantName,
      ownerName: row.merchantOwnerName,
      rejections,
      resubmissionUrl,
      expiresAt: formatExpiryDate(issued.expiresAt),
    }),
    caseId,
    merchantId: row.merchantId,
    idempotencyKey: `resubmit/${caseId}/${issued.tokenId}`,
    metadata: {
      tokenId: issued.tokenId,
      rejectedFields: rejectedFieldNames,
      recipientEmailType: recipient.recipientEmailType,
    },
  })

  // 7a. Email failed — invalidate the token, leave case in working
  if (emailResult.status === 'failed') {
    await db
      .update(caseResubmissionTokens)
      .set({ consumedAt: new Date() })
      .where(eq(caseResubmissionTokens.id, issued.tokenId))

    await db
      .update(cases)
      .set({
        status: 'working',
        currentStageId: row.currentStageId,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseId))

    await db.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'resubmission_email_failed',
      details: {
        tokenId: issued.tokenId,
        emailLogId: emailResult.emailLogId,
        error: emailResult.error ?? null,
      },
    })

    return {
      status: 'failed',
      tokenExpiresAt: null,
      emailLogId: emailResult.emailLogId,
      error: emailResult.error,
    }
  }

  // 7b. Email sent — record the rejection batch and move case to awaiting_client
  const sentAt = new Date()
  await db.transaction(async (tx) => {
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
      createdAt: preparedAt,
    })

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'resubmission_email_sent',
      details: {
        tokenId: issued.tokenId,
        expiresAt: issued.expiresAt.toISOString(),
        rejectedFields: rejectedFieldNames,
        rejectedFieldLabels,
        rejectedFieldDetails,
        emailLogId: emailResult.emailLogId,
        recipient: recipient.email,
        recipientEmailType: recipient.recipientEmailType,
      },
      createdAt: sentAt,
    })
  })

  return {
    status: 'sent',
    tokenExpiresAt: issued.expiresAt.toISOString(),
    emailLogId: emailResult.emailLogId,
  }
}

// ─── Resubmission Links ─────────────────────────────────────────────────────

export async function regenerateResubmissionLink(
  caseId: string,
  userId: string,
): Promise<RegeneratedResubmissionLinkResult> {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      status: cases.status,
      workflowType: queues.workflowType,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.workflowType !== 'document_review') {
    throw new AppError(
      400,
      'Resubmission links are only available for documents-review cases.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(
      403,
      'Only the case owner can regenerate the resubmission link.',
    )
  }
  if (row.status !== 'awaiting_client') {
    throw new AppError(
      400,
      'The case must be awaiting the merchant to regenerate its resubmission link.',
    )
  }

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
    throw new AppError(400, 'There are no rejected fields to resubmit.')
  }

  const documentIds = rejectedReviews
    .map((review) => getDocumentIdFromFieldName(review.fieldName))
    .filter((id): id is string => id !== null)
  const documentTypeById = new Map<string, string>()
  if (documentIds.length > 0) {
    const documents = await db
      .select({
        id: merchantDocuments.id,
        documentType: merchantDocuments.documentType,
      })
      .from(merchantDocuments)
      .where(inArray(merchantDocuments.id, documentIds))
    for (const document of documents) {
      documentTypeById.set(document.id, document.documentType)
    }
  }

  const rejectedFieldNames = rejectedReviews.map((review) => review.fieldName)
  const rejectedFieldLabels = rejectedReviews.map((review) =>
    getRejectionLabel(review.fieldName, documentTypeById),
  )
  const rejectedFieldDetails = rejectedReviews.map((review) => ({
    fieldName: review.fieldName,
    label: getRejectionLabel(review.fieldName, documentTypeById),
    type: isDocumentFieldName(review.fieldName) ? 'document' : 'text',
    rejectionReason: review.remarks,
  }))

  const linkDeadlines = await getLinkDeadlineSettings()
  const issued = await issueToken(
    caseId,
    userId,
    linkDeadlines.documentsReviewResubmissionHours,
  )
  const url = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/resubmit/${issued.token}`

  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'resubmission_link_regenerated',
    details: {
      tokenId: issued.tokenId,
      expiresAt: issued.expiresAt.toISOString(),
      rejectedFields: rejectedFieldNames,
      rejectedFieldLabels,
      rejectedFieldDetails,
    },
  })

  return {
    url,
    expiresAt: issued.expiresAt.toISOString(),
    rejectedFieldCount: rejectedReviews.length,
  }
}

export type ResubmissionContext = {
  caseId: string
  caseNumber: string
  expiresAt: string
  merchantName: string
  merchantId: string
  ownerId: string | null
  merchantOwnerName: string
  rejections: Array<{
    fieldName: string
    label: string
    remarks: string | null
    isDocument: boolean
    isRequired?: boolean
    currentValue?: string
    currentDocumentName?: string
    currentDocumentUrl?: string
    documentType?: string
  }>
}

export async function getResubmissionContext(
  caseId: string,
  expiresAt: Date,
): Promise<ResubmissionContext> {
  const db = getDb()

  const [caseRow] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      merchantId: cases.merchantId,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.id, caseRow.merchantId),
  })

  if (!merchant) {
    throw new AppError(404, 'Merchant not found.')
  }

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
  const docsById = new Map<
    string,
    {
      documentType: MerchantDocumentType
      originalName: string
      currentDocumentUrl?: string
    }
  >()
  if (docIds.length > 0) {
    const docs = await db
      .select({
        id: merchantDocuments.id,
        documentType: merchantDocuments.documentType,
        originalName: merchantDocuments.originalName,
        currentDocumentUrl: merchantDocuments.googleDriveWebViewLink,
      })
      .from(merchantDocuments)
      .where(inArray(merchantDocuments.id, docIds))
    for (const d of docs) {
      docsById.set(d.id, {
        documentType: d.documentType,
        originalName: d.originalName,
        currentDocumentUrl: d.currentDocumentUrl,
      })
    }
  }

  const merchantData = merchant as Record<string, unknown>
  const requiredDocumentTypes = new Set(
    getRequiredDocumentTypes(merchant.merchantType),
  )

  const rejections = rejectedReviews.map((review) => {
    if (isDocumentFieldName(review.fieldName)) {
      const docId = getDocumentIdFromFieldName(review.fieldName)
      const doc = docId ? docsById.get(docId) : null
      const label = doc
        ? DOCUMENT_TYPE_LABELS[
            doc.documentType as keyof typeof DOCUMENT_TYPE_LABELS
          ]
        : 'Uploaded document'
      return {
        fieldName: review.fieldName,
        label,
        remarks: review.remarks,
        isDocument: true,
        isRequired: doc ? requiredDocumentTypes.has(doc.documentType) : false,
        currentDocumentName: doc?.originalName,
        documentType: doc?.documentType,
        currentDocumentUrl: doc?.currentDocumentUrl,
      }
    }

    const value = merchantData[review.fieldName]
    return {
      fieldName: review.fieldName,
      label: MERCHANT_FIELD_LABELS[review.fieldName],
      remarks: review.remarks,
      isDocument: false,
      currentValue: value == null ? '' : String(value),
    }
  })

  return {
    caseId: caseRow.id,
    caseNumber: caseRow.caseNumber,
    expiresAt: expiresAt.toISOString(),
    merchantName: merchant.businessName,
    merchantId: merchant.id,
    ownerId: caseRow.ownerId,
    merchantOwnerName: merchant.ownerFullName,
    rejections,
  }
}
