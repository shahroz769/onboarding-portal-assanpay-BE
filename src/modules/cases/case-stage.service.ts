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
  enqueueCasesAfterSuccessfulClose,
} from './case-flow.service'
import { requestCaseFlowCloseJobDrain } from './case-flow-worker'
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
  assertTestingLimitsAppliedForCredentials,
  buildPortalPassword,
  ensureInheritedSubMerchantFormDetails,
  getCaseDetailMerchant,
  getClientPayoutRateLabel,
  getDocumentReviewDetails,
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

export async function updateCaseStatus(
  caseId: string,
  userId: string,
  input: UpdateCaseStatusInput,
) {
  const db = getDb()

  const [existing] = await db
    .select({
      id: cases.id,
      status: cases.status,
      merchantId: cases.merchantId,
      queueId: cases.queueId,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  if (existing.ownerId !== userId) {
    throw new AppError(
      403,
      'Only the current case owner can work on this case.',
    )
  }

  const currentStatus = existing.status as CaseStatusValue

  if (!isValidStatusTransition(currentStatus, input.status)) {
    throw new AppError(
      400,
      `Invalid status transition from "${currentStatus}" to "${input.status}".`,
    )
  }

  const stages = await db.query.queueStages.findMany({
    where: eq(queueStages.queueId, existing.queueId),
    orderBy: [asc(queueStages.order)],
  })

  const targetStage = resolveUniqueStageForStatus(stages, input.status)

  const updated = await transitionCaseState({
    caseId,
    actorId: userId,
    targetStage,
    requireOwner: true,
    checkCloseBlockers: input.status === 'closed',
    historyAction: 'status_updated',
    historyDetails: {
      fromStatus: currentStatus,
      toStatus: input.status,
      fromStageId: existing.currentStageId,
      toStageId: targetStage.id,
      toStage: targetStage.name,
    },
    expected: {
      status: currentStatus,
      currentStageId: existing.currentStageId,
      ownerId: userId,
    },
    conflictMessage: 'Case status was already updated.',
  })

  return {
    id: updated.id,
    status: updated.status,
    slaBreached: updated.slaBreached,
    closedAt: updated.closedAt,
    updatedAt: updated.updatedAt,
  }
}

// ─── Assign Case ────────────────────────────────────────────────────────────

export async function advanceStage(caseId: string, userId: string) {
  const db = getDb()

  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      caseNumber: cases.caseNumber,
      status: cases.status,
      priority: cases.priority,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (caseData.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can advance the stage.')
  }

  if (!caseData.currentStageId) {
    throw new AppError(400, 'Case has no current stage.')
  }

  const currentStageId = caseData.currentStageId

  const [currentStage, queue] = await Promise.all([
    loadQueueStageForCase(db, currentStageId, caseData.queueId),
    db.query.queues.findFirst({
      where: eq(queues.id, caseData.queueId),
      columns: {
        qcEnabled: true,
        slug: true,
        workflowType: true,
        slaHours: true,
      },
    }),
  ])

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Case can only be advanced from an in-progress stage.',
    )
  }

  if (!queue) {
    throw new AppError(500, 'Case queue is not configured.')
  }

  let targetStage = null

  if (queue != null && isQueueWorkflowType(queue, 'document_review')) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'Documents-review cases can only be closed successfully from working.',
      )
    }

    const documentReviewDetail = await getDocumentReviewDetails(caseId)
    if (!documentReviewDetail?.subMerchants.length) {
      throw new AppError(
        400,
        'Select at least one sub-merchant before closing this case.',
      )
    }

    const [activeRejection] = await db
      .select({ id: caseFieldReviews.id })
      .from(caseFieldReviews)
      .where(
        and(
          eq(caseFieldReviews.caseId, caseId),
          eq(caseFieldReviews.status, 'rejected'),
        ),
      )
      .limit(1)
    if (activeRejection) {
      throw new AppError(
        400,
        'Resolve all rejected fields and documents before closing this case.',
      )
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else if (queue != null && isQueueWorkflowType(queue, 'sub_merchant_form')) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'EP Sub-Merchant Form cases can only be closed successfully from working.',
      )
    }

    const details = await ensureInheritedSubMerchantFormDetails({
      caseId,
      merchantId: caseData.merchantId,
      actorId: userId,
    })

    if (!details) {
      throw new AppError(
        400,
        'Select a sub-merchant in the document review case before closing this case.',
      )
    }

    if (!details.finalFormId) {
      throw new AppError(400, 'Upload the Final Form before closing this case.')
    }

    if (details.emailStatus !== 'sent' || !details.emailProofId) {
      throw new AppError(
        400,
        'Upload the sent-email screenshot before closing this case.',
      )
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else if (queue != null && isQueueWorkflowType(queue, 'agreement')) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'Agreement cases can only be closed successfully from working.',
      )
    }

    const details = await db.query.agreementCaseDetails.findFirst({
      where: eq(agreementCaseDetails.caseId, caseId),
    })

    if (!details?.finalAgreementFileId) {
      throw new AppError(
        400,
        'Upload the Final Agreement before closing this case.',
      )
    }

    if (!details.receivedAgreementFileId) {
      throw new AppError(
        400,
        'Upload the signed physical agreement received by the office before closing this case.',
      )
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else if (queue != null && isQueueWorkflowType(queue, 'mid')) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'MID Creation cases can only be closed successfully from working.',
      )
    }

    const credentials = await getMidCreationCredentials(caseData.merchantId)
    if (!credentials) {
      throw new AppError(
        400,
        'Save the email, MID, and Branch Code for both merchant IDs before closing this case.',
      )
    }

    if (
      !credentials.branchCode.trim() ||
      !credentials.internalEmail.trim() ||
      !credentials.internalBranchCode.trim()
    ) {
      throw new AppError(
        400,
        'Save the email, MID, and Branch Code for both merchant IDs before closing this case.',
      )
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else if (queue != null && isQueueWorkflowType(queue, 'testing')) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'Testing cases can only be closed successfully from working.',
      )
    }

    const credentialsSentEntry =
      await getMidCreationCredentialsSentEntry(caseId)
    if (!credentialsSentEntry) {
      throw new AppError(
        400,
        'Send merchant portal credentials by auto Resend, manual Gmail, or WhatsApp before closing this case.',
      )
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else if (queue != null && isQueueWorkflowType(queue, 'live')) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'Live cases can only be closed successfully from working.',
      )
    }

    const limitsAppliedEntry = await getLiveLimitsAppliedEntry(caseId)
    if (!limitsAppliedEntry) {
      throw new AppError(
        400,
        'Confirm live limits were applied before closing this case.',
      )
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else if (queue != null && isQueueWorkflowType(queue, 'wordpress')) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'WordPress Website cases can only be closed successfully from working.',
      )
    }

    const details = await getWordpressWebsiteDetails(caseId)
    if (!details.clonedWebsiteLink) {
      throw new AppError(
        400,
        'Save the cloned WordPress website link before closing this case.',
      )
    }

    if (details.screenshots.length === 0) {
      throw new AppError(400, 'Upload screenshots before closing this case.')
    }

    const documentReview = await getLatestDocumentReviewDetailsForMerchant(
      caseData.merchantId,
    )
    if (
      !documentReview?.subMerchants.length ||
      documentReview.subMerchants.some(
        (subMerchant) =>
          !details.subMerchantLogoScreenshots.some(
            (screenshot) => screenshot.subMerchantId === subMerchant.id,
          ),
      )
    ) {
      throw new AppError(
        400,
        'Upload one website logo screenshot for each selected sub-merchant before closing this case.',
      )
    }

    if (details.assanpayCheckoutScreenshots.length === 0) {
      throw new AppError(
        400,
        'Upload the AssanPay checkout page screenshot before closing this case.',
      )
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else {
    const nextStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        gt(queueStages.order, currentStage.order),
      ),
      orderBy: asc(queueStages.order),
    })

    if (!nextStage) {
      throw new AppError(500, 'No next stage configured.')
    }

    targetStage = nextStage
    if (nextStage.category === 'qc' && !queue?.qcEnabled) {
      const closedStage = await db.query.queueStages.findFirst({
        where: and(
          eq(queueStages.queueId, caseData.queueId),
          eq(queueStages.category, 'closed'),
        ),
      })
      if (!closedStage) {
        throw new AppError(500, 'No closed stage configured.')
      }
      targetStage = closedStage
    }
  }

  const newStatus = getStatusForStage(targetStage)
  const now = new Date()

  const extraFields: {
    closeOutcome?: 'successful' | 'unsuccessful' | null
    closeReason?: string | null
    closedAt?: Date | null
    slaBreached?: boolean | null
  } = {}

  // If advancing to closed, mark successful
  if (targetStage.category === 'closed') {
    extraFields.closeOutcome = 'successful'
    extraFields.closeReason = null
    extraFields.closedAt = now
    extraFields.slaBreached = isCaseSlaBreached({
      createdAt: caseData.createdAt,
      evaluatedAt: now,
      slaHours: queue.slaHours,
    })
  }

  const action =
    targetStage.category === 'closed' ? 'closed_successful' : 'stage_advanced'

  const result = await transitionCaseState({
    caseId,
    actorId: userId,
    targetStage,
    requireOwner: true,
    checkCloseBlockers: targetStage.category === 'closed',
    historyAction: action,
    historyDetails: {
      fromStage: currentStage.name,
      toStage: targetStage.name,
    },
    extraFields,
    expected: {
      status: caseData.status as CaseStatusValue,
      currentStageId,
      ownerId: userId,
    },
    conflictMessage: 'Case stage was already updated.',
    afterUpdate: async (tx, locked, _updated, derivedStatus) => {
      if (targetStage.category !== 'closed' || derivedStatus !== 'closed') {
        return
      }

      await enqueueCasesAfterSuccessfulClose(tx, {
        id: caseId,
        merchantId: locked.merchantId,
        queueId: locked.queueId,
      })

      if (queue != null && isQueueWorkflowType(queue, 'testing')) {
        await tx
          .update(merchants)
          .set({
            status: 'testing',
            updatedAt: now,
          })
          .where(eq(merchants.id, caseData.merchantId))
      }

      if (queue != null && isQueueWorkflowType(queue, 'live')) {
        await tx
          .update(merchants)
          .set({
            status: 'live',
            liveAt: now,
            updatedAt: now,
          })
          .where(eq(merchants.id, caseData.merchantId))
      }
    },
  })

  if (targetStage.category === 'closed') {
    requestCaseFlowCloseJobDrain()
  }

  return result
}

// ─── Save Field Reviews ─────────────────────────────────────────────────────

export async function closeUnsuccessful(
  caseId: string,
  userId: string,
  input: CloseUnsuccessfulInput,
) {
  const db = getDb()

  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
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
    throw new AppError(403, 'Only the case owner can close the case.')
  }

  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, caseData.queueId),
    columns: { slug: true, workflowType: true, slaHours: true },
  })

  // Verify not already closed
  if (caseData.currentStageId) {
    const currentStage = await loadQueueStageForCase(
      db,
      caseData.currentStageId,
      caseData.queueId,
    )
    if (
      currentStage?.category === 'closed' ||
      currentStage?.category === 'error'
    ) {
      throw new AppError(400, 'Case is already in a terminal stage.')
    }
  }

  const terminalStages = await db.query.queueStages.findMany({
    where: and(
      eq(queueStages.queueId, caseData.queueId),
      inArray(queueStages.category, ['closed', 'error']),
    ),
  })
  const closedStage = terminalStages.find(
    (stage) => stage.category === 'closed',
  )
  const errorStage = terminalStages.find((stage) => stage.category === 'error')
  const prefersClosedStage =
    queue != null &&
    (isQueueWorkflowType(queue, 'document_review') ||
      isQueueWorkflowType(queue, 'agreement'))
  const terminalStage = prefersClosedStage
    ? (closedStage ?? errorStage)
    : (errorStage ?? closedStage)

  if (!terminalStage) {
    throw new AppError(500, 'No terminal stage configured for this queue.')
  }

  const now = new Date()

  return transitionCaseState({
    caseId,
    actorId: userId,
    targetStage: terminalStage,
    requireOwner: true,
    checkCloseBlockers: false,
    historyAction: 'closed_unsuccessful',
    historyDetails: { reason: input.reason },
    extraFields: {
      closeOutcome: 'unsuccessful',
      closeReason: input.reason,
      closedAt: now,
      slaBreached: isCaseSlaBreached({
        createdAt: caseData.createdAt,
        evaluatedAt: now,
        slaHours: queue?.slaHours,
      }),
    },
    expected: {
      status: caseData.status as CaseStatusValue,
      currentStageId: caseData.currentStageId,
      ownerId: userId,
    },
    conflictMessage: 'Case state was already updated.',
  })
}

// ─── Case Comments ──────────────────────────────────────────────────────────
