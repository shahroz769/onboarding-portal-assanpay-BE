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
  buildKeysetCondition,
  decodeKeysetCursor,
  encodeKeysetCursor,
  parseCsvValues,
} from './case-cursor'
import { generateCaseNumber } from './case-number'
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
  enrichResubmissionWhatsappHistoryDetails,
  getStringDetail,
  sanitizeCaseHistoryDetails,
} from './case-history-format'

export async function createCase(input: CreateCaseInput, actorId?: string) {
  const db = getDb()

  return db.transaction(async (tx) => {
    // Verify merchant exists
    const merchant = await tx.query.merchants.findFirst({
      where: eq(merchants.id, input.merchantId),
      columns: { id: true, businessName: true, priority: true },
    })

    if (!merchant) {
      throw new AppError(404, 'Merchant not found.')
    }

    // Verify queue exists
    const queue = await tx.query.queues.findFirst({
      where: eq(queues.id, input.queueId),
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
      throw new AppError(404, 'Queue not found.')
    }

    if (queue.lifecycle !== 'active') {
      throw new AppError(
        409,
        'This queue is inactive. Case creation is disabled.',
      )
    }

    const selectedSubMerchant = isQueueWorkflowType(
      queue,
      'sub_merchant_form',
    )
      ? input.subMerchantId
        ? await tx.query.subMerchantDraftTemplates.findFirst({
            where: eq(subMerchantDraftTemplates.id, input.subMerchantId),
            columns: {
              id: true,
              name: true,
              googleDriveWebViewLink: true,
            },
          })
        : null
      : null

    if (
      isQueueWorkflowType(queue, 'sub_merchant_form') &&
      !selectedSubMerchant
    ) {
      throw new AppError(
        400,
        'Select a valid sub-merchant before creating an EP Sub-Merchant Form case.',
      )
    }

    await assertCreationRequirementsSatisfied(tx, {
      merchantId: merchant.id,
      targetQueueId: queue.id,
    })

    const stages = await ensureQueueStages(tx, {
      id: queue.id,
      name: queue.name,
      slug: queue.slug,
      qcEnabled: queue.qcEnabled ?? false,
      workflowType: queue.workflowType,
    })
    const initialStage = stages[0]

    if (!initialStage) {
      throw new AppError(500, 'No initial stage configured for this queue.')
    }

    const caseNumber = await generateCaseNumber(tx, input.queueId)

    const [created] = await tx
      .insert(cases)
      .values({
        caseNumber,
        queueId: input.queueId,
        merchantId: input.merchantId,
        subMerchantId: selectedSubMerchant?.id ?? null,
        ownerId: null,
        currentStageId: initialStage.id,
        status: 'new',
        priority: merchant.priority,
        updatedAt: new Date(),
      })
      .returning()

    if (!created) {
      throw new AppError(500, 'Failed to create case.')
    }

    if (selectedSubMerchant) {
      await tx.insert(subMerchantFormDetails).values({
        caseId: created.id,
        subMerchantKey: selectedSubMerchant.id,
        subMerchantName: selectedSubMerchant.name,
        draftUrl: selectedSubMerchant.googleDriveWebViewLink,
      })
    }

    if (actorId) {
      await tx.insert(caseHistory).values({
        caseId: created.id,
        actorId,
        action: 'case_created_manually',
        details: {
          queueName: queue.name,
          merchantName: merchant.businessName,
          subMerchantId: selectedSubMerchant?.id ?? null,
          subMerchantName: selectedSubMerchant?.name ?? null,
        },
      })
    }

    return {
      id: created.id,
      caseNumber: created.caseNumber,
      queueId: created.queueId,
      queueName: queue.name,
      merchantId: created.merchantId,
      merchantName: merchant.businessName,
      ownerId: created.ownerId,
      ownerName: null as string | null,
      status: created.status,
      priority: created.priority,
      closedAt: created.closedAt,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    }
  })
}

// ─── List Cases ─────────────────────────────────────────────────────────────

export async function listCases(query: ListCasesQuery, actor?: SessionUser) {
  const db = getDb()
  const conditions = []
  const access =
    actor?.roleType === 'agent' ? await getAgentQueueAccess(actor.userId) : null

  if (access?.viewScope === 'selected') {
    if (access.viewQueueIds.length === 0) {
      conditions.push(sql`false`)
    } else {
      conditions.push(inArray(cases.queueId, access.viewQueueIds))
    }
  }

  if (query.search) {
    const term = `%${query.search}%`
    conditions.push(
      or(ilike(cases.caseNumber, term), ilike(merchants.businessName, term)),
    )
  }

  if (query.queueId) {
    if (
      access?.viewScope === 'selected' &&
      !access.viewQueueIds.includes(query.queueId)
    ) {
      conditions.push(sql`false`)
    } else {
      conditions.push(eq(cases.queueId, query.queueId))
    }
  }

  if (query.ownerId) {
    const ownerIds = query.ownerId
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    if (ownerIds.length > 0) {
      conditions.push(inArray(cases.ownerId, ownerIds))
    }
  }

  if (query.status) {
    const statuses = parseCsvValues<CaseStatusValue>(
      query.status,
      caseStatusValueSet,
    )
    if (statuses.length > 0) {
      conditions.push(inArray(cases.status, statuses))
    }
  }

  if (query.createdAtFrom) {
    const fromDate = new Date(query.createdAtFrom)
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gt(cases.createdAt, fromDate))
    }
  }

  if (query.createdAtTo) {
    const toDate = new Date(query.createdAtTo)
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lt(cases.createdAt, toDate))
    }
  }

  const sortColumnMap = {
    caseNumber: {
      expression: cases.caseNumber,
      kind: 'string',
    },
    status: {
      expression: cases.status,
      kind: 'string',
    },
    createdAt: {
      expression: cases.createdAt,
      kind: 'date',
    },
    closedAt: {
      expression: sql`coalesce(${cases.closedAt}, '0001-01-01 00:00:00+00'::timestamptz)`,
      kind: 'date',
    },
    updatedAt: {
      expression: cases.updatedAt,
      kind: 'date',
    },
    merchantName: {
      expression: sql`lower(${merchants.businessName})`,
      kind: 'string',
    },
  } as const

  const orderFn = query.sortOrder === 'desc' ? desc : asc
  const sortSpec = sortColumnMap[query.sortBy]
  const cursor = query.cursor
    ? decodeKeysetCursor(query.cursor, {
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        kind: sortSpec.kind,
      })
    : null

  if (cursor) {
    conditions.push(
      buildKeysetCondition({
        expression: sortSpec.expression,
        idExpression: cases.id,
        sortOrder: query.sortOrder,
        value: cursor.value,
        id: cursor.id,
      }),
    )
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined
  const rows = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      queueName: queues.name,
      queueSlaHours: queues.slaHours,
      slaBreached: cases.slaBreached,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      subMerchantName: subMerchantDraftTemplates.name,
      ownerId: cases.ownerId,
      ownerName: users.name,
      status: cases.status,
      priority: cases.priority,
      closeOutcome: cases.closeOutcome,
      closedAt: cases.closedAt,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
      cursorValue: sortSpec.expression,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .leftJoin(
      subMerchantDraftTemplates,
      eq(cases.subMerchantId, subMerchantDraftTemplates.id),
    )
    .leftJoin(users, eq(cases.ownerId, users.id))
    .where(where)
    .orderBy(orderFn(sortSpec.expression), orderFn(cases.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows
  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeKeysetCursor({
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          value: pageRows[pageRows.length - 1]!.cursorValue,
          id: pageRows[pageRows.length - 1]!.id,
        })
      : null
  const items = pageRows.map((pageRow) => {
    const row = { ...pageRow }
    delete (row as { cursorValue?: unknown }).cursorValue
    return row
  })

  return {
    cases: items,
    nextCursor,
    hasMore,
    limit: query.limit,
  }
}

export async function listCaseOwners() {
  const db = getDb()

  const rows = await db
    .selectDistinct({
      id: users.id,
      name: users.name,
    })
    .from(cases)
    .innerJoin(users, eq(cases.ownerId, users.id))

  return rows
}

// ─── Bulk Assign Cases ──────────────────────────────────────────────────────

export async function getCaseDetail(caseId: string, actor?: SessionUser) {
  const db = getDb()
  await assertCanViewCase(caseId, actor)

  // Get case with joins
  const caseRow = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      ownerId: cases.ownerId,
      ownerName: users.name,
      currentStageId: cases.currentStageId,
      status: cases.status,
      priority: cases.priority,
      closeOutcome: cases.closeOutcome,
      slaBreached: cases.slaBreached,
      closeReason: cases.closeReason,
      closedAt: cases.closedAt,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .leftJoin(users, eq(cases.ownerId, users.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = caseRow[0]

  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, caseData.queueId),
  })

  if (!queue) {
    throw new AppError(500, 'Case data integrity error.')
  }

  const workflowType = queue.workflowType
  const needsMerchantDocuments =
    workflowType === 'document_review' ||
    workflowType === 'card' ||
    workflowType === 'sub_merchant_form'
  const needsMidCredentials =
    workflowType === 'mid' ||
    workflowType === 'testing' ||
    workflowType === 'wordpress'

  // Fetch core data plus only the projection required by this workflow.
  const [
    stagesResult,
    merchantRow,
    documents,
    fieldReviews,
    latestResubmissionEntry,
    subMerchantForm,
    agreement,
    testingLimitsAppliedEntry,
    liveLimitsAppliedEntry,
    internalPortalMidLimitsAppliedEntry,
    wordpressWebsiteDetails,
    merchantWordpressWebsiteDetails,
    caseDocumentReviewDetail,
    merchantDocumentReviewDetail,
    midCreationCredentials,
    paymentMethods,
    payoutMethods,
  ] = await Promise.all([
    db
      .select()
      .from(queueStages)
      .where(eq(queueStages.queueId, caseData.queueId))
      .orderBy(asc(queueStages.order)),
    db.query.merchants.findFirst({
      where: eq(merchants.id, caseData.merchantId),
    }),
    needsMerchantDocuments
      ? db
          .select()
          .from(merchantDocuments)
          .where(eq(merchantDocuments.merchantId, caseData.merchantId))
      : Promise.resolve([]),
    workflowType === 'document_review'
      ? db
          .select({
            id: caseFieldReviews.id,
            fieldName: caseFieldReviews.fieldName,
            status: caseFieldReviews.status,
            remarks: caseFieldReviews.remarks,
            reviewedBy: caseFieldReviews.reviewedBy,
            reviewedByName: users.name,
            updatedAt: caseFieldReviews.updatedAt,
            resubmittedAt: caseFieldReviews.resubmittedAt,
          })
          .from(caseFieldReviews)
          .leftJoin(users, eq(caseFieldReviews.reviewedBy, users.id))
          .where(eq(caseFieldReviews.caseId, caseId))
      : Promise.resolve([]),
    workflowType === 'document_review'
      ? db
          .select({ createdAt: caseHistory.createdAt })
          .from(caseHistory)
          .where(
            and(
              eq(caseHistory.caseId, caseId),
              inArray(
                caseHistory.action,
                DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS,
              ),
            ),
          )
          .orderBy(desc(caseHistory.createdAt))
          .limit(1)
          .then((rows: Array<{ createdAt: Date }>) => rows[0] ?? null)
      : Promise.resolve(null),
    Promise.resolve(null),
    workflowType === 'agreement'
      ? db
          .select({
            businessType: agreementCaseDetails.businessType,
            draftKey: agreementCaseDetails.draftKey,
            draftLabel: agreementCaseDetails.draftLabel,
            draftUrl: agreementCaseDetails.draftUrl,
            emailStatus: agreementCaseDetails.emailStatus,
            emailLogId: agreementCaseDetails.emailLogId,
            emailSentAt: agreementCaseDetails.emailSentAt,
            emailRecipient: agreementCaseDetails.emailRecipient,
            lastRejectionRemarks: agreementCaseDetails.lastRejectionRemarks,
            finalAgreementId: caseFiles.id,
            finalAgreementOriginalName: caseFiles.originalName,
            finalAgreementMimeType: caseFiles.mimeType,
            finalAgreementSizeBytes: caseFiles.sizeBytes,
            finalAgreementGoogleDriveWebViewLink:
              caseFiles.googleDriveWebViewLink,
            finalAgreementGoogleDriveDownloadLink:
              caseFiles.googleDriveDownloadLink,
            finalAgreementCreatedAt: caseFiles.createdAt,
          })
          .from(agreementCaseDetails)
          .leftJoin(
            caseFiles,
            eq(agreementCaseDetails.finalAgreementFileId, caseFiles.id),
          )
          .where(eq(agreementCaseDetails.caseId, caseId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    workflowType === 'testing'
      ? getTestingLimitsAppliedEntryForMerchant(caseData.merchantId)
      : Promise.resolve(null),
    workflowType === 'live'
      ? getLiveLimitsAppliedEntry(caseId)
      : Promise.resolve(null),
    workflowType === 'mid'
      ? getInternalPortalMidLimitsAppliedEntryForMerchant(caseData.merchantId)
      : Promise.resolve(null),
    workflowType === 'wordpress'
      ? getWordpressWebsiteDetails(caseId)
      : Promise.resolve(null),
    workflowType === 'sub_merchant_form'
      ? getLatestWordpressWebsiteDetailsForMerchant(caseData.merchantId)
      : Promise.resolve(null),
    workflowType === 'document_review'
      ? getDocumentReviewDetails(caseId)
      : Promise.resolve(null),
    workflowType === 'wordpress'
      ? getLatestDocumentReviewDetailsForMerchant(caseData.merchantId)
      : Promise.resolve(null),
    needsMidCredentials
      ? getMidCreationCredentials(caseData.merchantId)
      : Promise.resolve(null),
    workflowType === 'mid'
      ? getPaymentMethodSettings()
      : Promise.resolve([]),
    workflowType === 'mid'
      ? getPayoutMethodSettings()
      : Promise.resolve([]),
  ])

  if (!merchantRow) {
    throw new AppError(500, 'Case data integrity error.')
  }

  const merchant = merchantRow
  const merchantForDetail = getCaseDetailMerchant({
    merchant: merchantRow,
    workflowType: queue.workflowType,
    ownerId: caseData.ownerId,
    actor,
  })

  const seededStages =
    stagesResult.length > 0
      ? stagesResult
      : await ensureQueueStages(db, {
          id: queue.id,
          name: queue.name,
          slug: queue.slug,
          qcEnabled: queue.qcEnabled,
          workflowType: queue.workflowType,
        })

  const stages = getVisibleStagesForQueue(seededStages, caseData.currentStageId)

  const currentStage =
    resolveStageForCase({
      stages: stages.length > 0 ? stages : seededStages,
      currentStageId: caseData.currentStageId,
      status: caseData.status as CaseStatusValue,
    }) ?? null

  if (currentStage && currentStage.id !== caseData.currentStageId) {
    await db
      .update(cases)
      .set({
        currentStageId: currentStage.id,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseId))
  }

  let agreementRecord = agreement
  if (!agreementRecord && isQueueWorkflowType(queue, 'agreement')) {
    const draft = await getConfiguredAgreementDraftForMerchantType(
      merchant.merchantType,
    )
    const [createdAgreement] = await db
      .insert(agreementCaseDetails)
      .values({
        caseId,
        businessType: merchant.merchantType,
        draftKey: draft.key,
        draftLabel: draft.label,
        draftUrl: draft.draftUrl,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agreementCaseDetails.caseId,
        set: {
          businessType: merchant.merchantType,
          draftKey: draft.key,
          draftLabel: draft.label,
          draftUrl: draft.draftUrl,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!createdAgreement) {
      throw new AppError(500, 'Failed to initialize agreement case details.')
    }

    agreementRecord = {
          businessType: createdAgreement.businessType,
          draftKey: createdAgreement.draftKey,
          draftLabel: createdAgreement.draftLabel,
          draftUrl: createdAgreement.draftUrl,
          emailStatus: createdAgreement.emailStatus,
          emailLogId: createdAgreement.emailLogId,
          emailSentAt: createdAgreement.emailSentAt,
          emailRecipient: createdAgreement.emailRecipient,
          lastRejectionRemarks: createdAgreement.lastRejectionRemarks,
          finalAgreementId: null,
          finalAgreementOriginalName: null,
          finalAgreementMimeType: null,
          finalAgreementSizeBytes: null,
          finalAgreementGoogleDriveWebViewLink: null,
          finalAgreementGoogleDriveDownloadLink: null,
          finalAgreementCreatedAt: null,
        }
  }

  const clientAgreement = agreementRecord
    ? await db.query.caseFiles.findFirst({
        where: and(
          eq(caseFiles.caseId, caseId),
          eq(caseFiles.fileKind, AGREEMENT_CLIENT_FILE_KIND),
        ),
      })
    : null
  const physicalAgreement =
    isQueueWorkflowType(queue, 'physical_agreement')
      ? await db.query.caseFiles.findFirst({
          where: and(
            eq(caseFiles.caseId, caseId),
            eq(caseFiles.fileKind, PHYSICAL_AGREEMENT_FILE_KIND),
          ),
        })
      : null
  const documentReviewDetail =
    isQueueWorkflowType(queue, 'wordpress')
      ? merchantDocumentReviewDetail
      : caseDocumentReviewDetail
  const resolvedWordpressWebsiteDetails =
    isQueueWorkflowType(queue, 'sub_merchant_form')
      ? (merchantWordpressWebsiteDetails ?? wordpressWebsiteDetails)
      : wordpressWebsiteDetails
  const subMerchantFormRecord =
    isQueueWorkflowType(queue, 'sub_merchant_form')
      ? await ensureInheritedSubMerchantFormDetails({
          caseId,
          merchantId: caseData.merchantId,
        })
      : subMerchantForm

  return {
    case: {
      id: caseData.id,
      caseNumber: caseData.caseNumber,
      status: caseData.status,
      priority: caseData.priority,
      closeOutcome: caseData.closeOutcome,
      slaBreached: caseData.slaBreached,
      closeReason: caseData.closeReason,
      closedAt: caseData.closedAt,
      createdAt: caseData.createdAt,
      updatedAt: caseData.updatedAt,
    },
    currentStage,
    stages,
    queue: {
      id: queue.id,
      name: queue.name,
      slug: queue.slug,
      workflowType: queue.workflowType,
      lifecycle: queue.lifecycle,
      qcEnabled: queue.qcEnabled,
      slaHours: queue.slaHours,
    },
    merchant: merchantForDetail,
    documents,
    fieldReviews,
    subMerchantForm: subMerchantFormRecord
      ? {
          subMerchantKey: subMerchantFormRecord.subMerchantKey,
          subMerchantName: subMerchantFormRecord.subMerchantName,
          sellerCode: subMerchantFormRecord.sellerCode,
          draftUrl: subMerchantFormRecord.draftUrl,
          emailStatus: subMerchantFormRecord.emailStatus,
          emailLogId: subMerchantFormRecord.emailLogId,
          emailSentAt: subMerchantFormRecord.emailSentAt,
          emailRecipient: subMerchantFormRecord.emailRecipient,
          finalForm: subMerchantFormRecord.finalFormId
            ? {
                id: subMerchantFormRecord.finalFormId,
                originalName: subMerchantFormRecord.finalFormOriginalName,
                mimeType: subMerchantFormRecord.finalFormMimeType,
                sizeBytes: subMerchantFormRecord.finalFormSizeBytes,
                googleDriveWebViewLink:
                  subMerchantFormRecord.finalFormGoogleDriveWebViewLink,
                googleDriveDownloadLink:
                  subMerchantFormRecord.finalFormGoogleDriveDownloadLink,
                createdAt: subMerchantFormRecord.finalFormCreatedAt,
              }
            : null,
          emailProof: subMerchantFormRecord.emailProofId
            ? {
                id: subMerchantFormRecord.emailProofId,
                originalName: subMerchantFormRecord.emailProofOriginalName,
                mimeType: subMerchantFormRecord.emailProofMimeType,
                sizeBytes: subMerchantFormRecord.emailProofSizeBytes,
                googleDriveWebViewLink:
                  subMerchantFormRecord.emailProofGoogleDriveWebViewLink,
                googleDriveDownloadLink:
                  subMerchantFormRecord.emailProofGoogleDriveDownloadLink,
                createdAt: subMerchantFormRecord.emailProofCreatedAt,
              }
            : null,
        }
      : null,
    agreement: agreementRecord
      ? {
          businessType: agreementRecord.businessType,
          draftKey: agreementRecord.draftKey,
          draftLabel: agreementRecord.draftLabel,
          draftUrl: agreementRecord.draftUrl,
          emailStatus: agreementRecord.emailStatus,
          emailLogId: agreementRecord.emailLogId,
          emailSentAt: agreementRecord.emailSentAt,
          emailRecipient: agreementRecord.emailRecipient,
          lastRejectionRemarks: agreementRecord.lastRejectionRemarks,
          finalAgreement: agreementRecord.finalAgreementId
            ? {
                id: agreementRecord.finalAgreementId,
                originalName: agreementRecord.finalAgreementOriginalName,
                mimeType: agreementRecord.finalAgreementMimeType,
                sizeBytes: agreementRecord.finalAgreementSizeBytes,
                googleDriveWebViewLink:
                  agreementRecord.finalAgreementGoogleDriveWebViewLink,
                googleDriveDownloadLink:
                  agreementRecord.finalAgreementGoogleDriveDownloadLink,
                createdAt: agreementRecord.finalAgreementCreatedAt,
              }
            : null,
          clientAgreement: clientAgreement
            ? {
                id: clientAgreement.id,
                originalName: clientAgreement.originalName,
                mimeType: clientAgreement.mimeType,
                sizeBytes: clientAgreement.sizeBytes,
                googleDriveWebViewLink: clientAgreement.googleDriveWebViewLink,
                googleDriveDownloadLink:
                  clientAgreement.googleDriveDownloadLink,
                createdAt: clientAgreement.createdAt,
              }
            : null,
        }
      : null,
    physicalAgreement: physicalAgreement
      ? {
          id: physicalAgreement.id,
          originalName: physicalAgreement.originalName,
          mimeType: physicalAgreement.mimeType,
          sizeBytes: physicalAgreement.sizeBytes,
          googleDriveWebViewLink: physicalAgreement.googleDriveWebViewLink,
          googleDriveDownloadLink: physicalAgreement.googleDriveDownloadLink,
          createdAt: physicalAgreement.createdAt,
        }
      : null,
    latestResubmissionRequestedAt:
      latestResubmissionEntry?.createdAt?.toISOString() ?? null,
    testing: {
      limitsAppliedAt:
        testingLimitsAppliedEntry?.createdAt?.toISOString() ?? null,
      limitsAppliedBy: testingLimitsAppliedEntry?.actorId
        ? {
            id: testingLimitsAppliedEntry.actorId,
            name: testingLimitsAppliedEntry.actorName ?? 'Unknown',
          }
        : null,
      credentialsReady: isQueueWorkflowType(queue, 'mid')
        ? Boolean(
            midCreationCredentials?.branchCode.trim() &&
              midCreationCredentials.internalEmail.trim() &&
              midCreationCredentials.internalBranchCode.trim(),
          )
        : Boolean(midCreationCredentials),
      portalMid:
        isQueueWorkflowType(queue, 'mid')
          ? (midCreationCredentials?.portalMid ?? null)
          : null,
      internalPortalMid:
        isQueueWorkflowType(queue, 'mid') ||
        isQueueWorkflowType(queue, 'wordpress')
          ? (midCreationCredentials?.internalPortalMid ?? null)
          : null,
      email:
        isQueueWorkflowType(queue, 'mid')
          ? (midCreationCredentials?.email ?? null)
          : null,
      branchCode:
        isQueueWorkflowType(queue, 'mid')
          ? (midCreationCredentials?.branchCode ?? null)
          : null,
      internalEmail:
        isQueueWorkflowType(queue, 'mid') ||
        isQueueWorkflowType(queue, 'wordpress')
          ? (midCreationCredentials?.internalEmail ?? null)
          : null,
      internalBranchCode:
        isQueueWorkflowType(queue, 'mid')
          ? (midCreationCredentials?.internalBranchCode ?? null)
          : null,
      internalLimitsAppliedAt:
        internalPortalMidLimitsAppliedEntry?.createdAt?.toISOString() ?? null,
      internalLimitsAppliedBy: internalPortalMidLimitsAppliedEntry?.actorId
        ? {
            id: internalPortalMidLimitsAppliedEntry.actorId,
            name: internalPortalMidLimitsAppliedEntry.actorName ?? 'Unknown',
          }
        : null,
      merchantRole:
        isQueueWorkflowType(queue, 'mid')
          ? (midCreationCredentials?.merchantRole ?? null)
          : null,
      paymentMethods:
        isQueueWorkflowType(queue, 'mid')
          ? (midCreationCredentials?.paymentMethods ?? paymentMethods)
          : null,
      payoutMethods:
        isQueueWorkflowType(queue, 'mid')
          ? (midCreationCredentials?.payoutMethods ?? payoutMethods)
          : null,
    },
    live: {
      limitsAppliedAt: liveLimitsAppliedEntry?.createdAt?.toISOString() ?? null,
      limitsAppliedBy: liveLimitsAppliedEntry?.actorId
        ? {
            id: liveLimitsAppliedEntry.actorId,
            name: liveLimitsAppliedEntry.actorName ?? 'Unknown',
          }
        : null,
    },
    wordpressWebsite: resolvedWordpressWebsiteDetails,
    documentReview: documentReviewDetail,
    owner: caseData.ownerId
      ? { id: caseData.ownerId, name: caseData.ownerName ?? 'Unknown' }
      : null,
  }
}

// ─── Take Ownership ─────────────────────────────────────────────────────────
