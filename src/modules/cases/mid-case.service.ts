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
import { generatePublicTokenString } from './case-public-token'
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
import { ensurePhysicalAgreementCaseForMerchant } from './physical-agreement-case.service'

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

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await loadQueueStageForCase(db, caseRow.currentStageId, caseRow.queueId)
    : null

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(400, 'MID details can only be saved in working.')
  }

  const payoutMethods = await getPayoutMethodsForMerchantRole(
    input.merchantRole,
  )
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
  goLiveAvailableAt: string | null
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

  const now = new Date()
  const [linkDeadlines, limitsAndMdr, merchantPortal] = await Promise.all([
    getLinkDeadlineSettings(),
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])
  const availableAt =
    linkDeadlines.goLiveAvailabilityHours == null
      ? now
      : new Date(
          now.getTime() +
            linkDeadlines.goLiveAvailabilityHours * 60 * 60 * 1000,
        )
  const token = generatePublicTokenString()
  const tokenHash = await hashToken(token)

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

  if (!tokenRow) {
    throw new AppError(500, 'Failed to issue Go-Live token.')
  }

  const goLiveUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/go-live/${token}`
  const isShopify = caseRow.websiteCms === 'shopify'
  const cardRate = isShopify
    ? `${limitsAndMdr.rates.cardShopify}%`
    : `${limitsAndMdr.rates.cardDefault}%`
  const portalPassword = buildPortalPassword(
    credentials.email,
    caseRow.merchantNumber,
  )
  const payoutRateLabel = getClientPayoutRateLabel(credentials.merchantRole)

  const emailResult = await sendEmail({
    to: recipient.email,
    subject: `AssanPay merchant portal credentials for ${caseRow.merchantName}`,
    template: 'mid-creation',
    react: MidCreationEmail({
      merchantName: caseRow.merchantName,
      portalEmail: credentials.email,
      portalPassword,
      merchantPortalUrl: merchantPortal.loginUrl,
      goLiveUrl,
      availableAt: formatEmailDateTime(availableAt),
      goLiveAvailabilityHours: linkDeadlines.goLiveAvailabilityHours,
      testingLimits: limitsAndMdr.testing,
      rates: {
        eWallets: limitsAndMdr.rates.eWallets,
        card: isShopify
          ? limitsAndMdr.rates.cardShopify
          : limitsAndMdr.rates.cardDefault,
        payout: limitsAndMdr.rates.payout,
        payoutLabel: payoutRateLabel,
      },
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `mid-creation/${caseId}/${tokenRow.id}`,
    metadata: {
      tokenId: tokenRow.id,
      availableAt: availableAt.toISOString(),
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      portalEmail: credentials.email,
      portalMid: credentials.portalMid,
      websiteCms: caseRow.websiteCms,
      cardRate,
      limitsAndMdr,
      goLiveAvailabilityHours: linkDeadlines.goLiveAvailabilityHours,
      merchantPortalUrl: merchantPortal.loginUrl,
    },
  })

  if (emailResult.status === 'failed') {
    await db
      .update(midGoLiveTokens)
      .set({ consumedAt: new Date() })
      .where(eq(midGoLiveTokens.id, tokenRow.id))
  }

  if (emailResult.status === 'sent') {
    await db.transaction((tx) =>
      ensurePhysicalAgreementCaseForMerchant(tx, {
        merchantId: caseRow.merchantId,
        parentCaseId: caseId,
        sourceQueueId: caseRow.queueId,
      }),
    )
  }

  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action:
      emailResult.status === 'sent'
        ? 'mid_creation_email_sent'
        : 'mid_creation_email_failed',
    details: {
      tokenId: tokenRow.id,
      emailLogId: emailResult.emailLogId,
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      portalMid: credentials.portalMid,
      availableAt:
        emailResult.status === 'sent' ? availableAt.toISOString() : null,
      error: emailResult.error ?? null,
    },
  })

  if (emailResult.status === 'failed') {
    return {
      status: 'failed',
      emailLogId: emailResult.emailLogId,
      goLiveAvailableAt: null,
      error: emailResult.error,
    }
  }

  return {
    status: 'sent',
    emailLogId: emailResult.emailLogId,
    goLiveAvailableAt: availableAt.toISOString(),
  }
}

export type MidGoLiveContext = {
  status: 'not_ready' | 'ready' | 'started'
  caseNumber: string
  merchantName: string
  availableAt: string
  availableInHours: number
  liveCaseNumber: string | null
}

export async function getMidGoLiveContext(
  token: string,
): Promise<MidGoLiveContext> {
  const db = getDb()
  const tokenHash = await hashToken(token)
  const [row] = await db
    .select({
      tokenId: midGoLiveTokens.id,
      availableAt: midGoLiveTokens.availableAt,
      consumedAt: midGoLiveTokens.consumedAt,
      liveCaseId: midGoLiveTokens.liveCaseId,
      createdAt: midGoLiveTokens.createdAt,
      midCaseNumber: cases.caseNumber,
      merchantName: merchants.businessName,
    })
    .from(midGoLiveTokens)
    .innerJoin(cases, eq(midGoLiveTokens.caseId, cases.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(
      or(
        eq(midGoLiveTokens.tokenHash, tokenHash),
        eq(midGoLiveTokens.token, token),
      ),
    )
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Go-Live link not found.')
  }

  const isStarted = Boolean(row.consumedAt && row.liveCaseId)
  const isReady = row.availableAt.getTime() <= Date.now()
  const availableInHours = Math.max(
    0,
    Math.round(
      (row.availableAt.getTime() - row.createdAt.getTime()) / (60 * 60 * 1000),
    ),
  )
  const liveCase = row.liveCaseId
    ? await db.query.cases.findFirst({
        where: eq(cases.id, row.liveCaseId),
        columns: { caseNumber: true },
      })
    : null

  return {
    status: isStarted ? 'started' : isReady ? 'ready' : 'not_ready',
    caseNumber: row.midCaseNumber,
    merchantName: row.merchantName,
    availableAt: row.availableAt.toISOString(),
    availableInHours,
    liveCaseNumber: liveCase?.caseNumber ?? null,
  }
}

export async function activateMidGoLive(token: string) {
  const db = getDb()
  const tokenHash = await hashToken(token)

  return db.transaction(async (tx) => {
    // Serialize retries across all API processes before reading token state.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${token}))`)

    const [tokenRow] = await tx
      .select({
        id: midGoLiveTokens.id,
        caseId: midGoLiveTokens.caseId,
        availableAt: midGoLiveTokens.availableAt,
        consumedAt: midGoLiveTokens.consumedAt,
        liveCaseId: midGoLiveTokens.liveCaseId,
        merchantId: cases.merchantId,
        midQueueId: cases.queueId,
        midCaseNumber: cases.caseNumber,
        midCaseStatus: cases.status,
        midCaseCreatedAt: cases.createdAt,
        midCaseQueueSlaHours: queues.slaHours,
        merchantName: merchants.businessName,
      })
      .from(midGoLiveTokens)
      .innerJoin(cases, eq(midGoLiveTokens.caseId, cases.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .where(
        or(
          eq(midGoLiveTokens.tokenHash, tokenHash),
          eq(midGoLiveTokens.token, token),
        ),
      )
      .limit(1)

    if (!tokenRow) {
      throw new AppError(404, 'Go-Live link not found.')
    }

    if (tokenRow.consumedAt && tokenRow.liveCaseId) {
      const liveCase = await tx.query.cases.findFirst({
        where: eq(cases.id, tokenRow.liveCaseId),
        columns: { caseNumber: true },
      })
      return {
        success: true as const,
        alreadyStarted: true,
        caseNumber: tokenRow.midCaseNumber,
        liveCaseId: tokenRow.liveCaseId,
        liveCaseNumber: liveCase?.caseNumber ?? null,
      }
    }

    if (tokenRow.consumedAt) {
      throw new AppError(410, 'This Go-Live link has already been used.')
    }

    if (tokenRow.availableAt.getTime() > Date.now()) {
      throw new AppError(
        425,
        `This Go-Live link works after ${formatEmailDateTime(tokenRow.availableAt)}.`,
      )
    }

    const liveQueue = await tx.query.queues.findFirst({
      where: eq(queues.workflowType, 'live'),
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
    if (!liveQueue) {
      throw new AppError(500, 'Live queue is not configured.')
    }
    if (liveQueue.lifecycle !== 'active') {
      throw new AppError(409, 'Live queue is inactive. Go-Live is disabled.')
    }

    const existingLiveCase = await tx.query.cases.findFirst({
      where: and(
        eq(cases.queueId, liveQueue.id),
        eq(cases.merchantId, tokenRow.merchantId),
      ),
      columns: { id: true, caseNumber: true },
    })

    const now = new Date()
    let liveCaseId = existingLiveCase?.id ?? null
    let liveCaseNumber = existingLiveCase?.caseNumber ?? null

    if (!existingLiveCase) {
      await assertCreationRequirementsSatisfied(tx, {
        merchantId: tokenRow.merchantId,
        targetQueueId: liveQueue.id,
      })

      const liveStages = await ensureQueueStages(tx, {
        id: liveQueue.id,
        name: liveQueue.name,
        slug: liveQueue.slug,
        qcEnabled: liveQueue.qcEnabled,
        workflowType: liveQueue.workflowType,
      })
      const initialStage = liveStages[0]
      if (!initialStage) {
        throw new AppError(500, 'No initial stage configured for Live queue.')
      }

      const caseNumber = await generateCaseNumber(tx, liveQueue.id)
      const [createdLiveCase] = await tx
        .insert(cases)
        .values({
          caseNumber,
          queueId: liveQueue.id,
          merchantId: tokenRow.merchantId,
          ownerId: null,
          currentStageId: initialStage.id,
          status: 'new',
          updatedAt: now,
        })
        .returning({ id: cases.id, caseNumber: cases.caseNumber })

      if (!createdLiveCase) {
        throw new AppError(500, 'Failed to create Live case.')
      }

      liveCaseId = createdLiveCase.id
      liveCaseNumber = createdLiveCase.caseNumber

      await tx.insert(caseHistory).values({
        caseId: createdLiveCase.id,
        actorId: null,
        action: 'case_created_from_mid_go_live',
        details: {
          midCaseId: tokenRow.caseId,
          midCaseNumber: tokenRow.midCaseNumber,
          merchantName: tokenRow.merchantName,
        },
      })
    }

    const closedStage = await tx.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, tokenRow.midQueueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    await tx
      .update(midGoLiveTokens)
      .set({
        consumedAt: now,
        liveCaseId,
      })
      .where(eq(midGoLiveTokens.id, tokenRow.id))

    if (tokenRow.midCaseStatus !== 'closed') {
      await tx
        .update(cases)
        .set({
          status: 'closed',
          currentStageId: closedStage?.id ?? null,
          closeOutcome: 'successful',
          slaBreached: isCaseSlaBreached({
            createdAt: tokenRow.midCaseCreatedAt,
            evaluatedAt: now,
            slaHours: tokenRow.midCaseQueueSlaHours,
          }),
          closeReason: null,
          closedAt: now,
          updatedAt: now,
        })
        .where(eq(cases.id, tokenRow.caseId))
    }

    await tx.insert(caseHistory).values({
      caseId: tokenRow.caseId,
      actorId: null,
      action: 'mid_go_live_started',
      details: {
        tokenId: tokenRow.id,
        liveCaseId,
        liveCaseNumber,
      },
    })

    return {
      success: true as const,
      alreadyStarted: Boolean(existingLiveCase),
      caseNumber: tokenRow.midCaseNumber,
      liveCaseId,
      liveCaseNumber,
    }
  })
}
