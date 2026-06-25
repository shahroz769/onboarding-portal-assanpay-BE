import {
  and,
  asc,
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
  queues,
  queueCaseSequences,
  queueStages,
  subMerchantFormDetails,
  subMerchantDraftTemplates,
  userQueueAccess,
  users,
} from '../../db/schema'
import type { Merchant } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { env } from '../../config/env'
import type { SessionUser } from '../../types/auth'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import {
  ensureQueueStages,
  getVisibleStagesForQueue,
  getStatusForStage,
  resolveStageForCase,
} from '../queues/queue-stage-defaults'
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
  assertCloseBlockersSatisfied,
  assertCreationRequirementsSatisfied,
  triggerCasesAfterSuccessfulClose,
} from './case-flow.service'
import { getRequiredDocumentTypes } from '../merchants/merchants.schemas'
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
  SaveDocumentReviewSubMerchantInput,
  SaveFieldReviewsInput,
  SaveMidCreationDetailsInput,
  SaveWordpressWebsiteInput,
  SelectSubMerchantFormInput,
  SendLiveEmailInput,
  SendMidCreationEmailInput,
  UpdateCaseStatusInput,
} from './cases.schemas'
import {
  AGREEMENT_CLIENT_FILE_KIND,
  AGREEMENT_FINAL_FILE_KIND,
  AGREEMENT_QUEUE_SLUG,
} from './agreement.config'
import {
  SUB_MERCHANT_EMAIL_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_KIND,
  SUB_MERCHANT_FORM_QUEUE_SLUG,
} from './sub-merchant-form.config'
import { isCaseSlaBreached } from './case-sla'

const caseStatusValueSet = new Set<string>(caseStatusValues)
const MAX_SUB_MERCHANT_FINAL_FORM_BYTES = 1024 * 1024
const SUB_MERCHANT_FINAL_FORM_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const SUB_MERCHANT_FINAL_FORM_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])
const AGREEMENT_FILE_MIME_TYPES = SUB_MERCHANT_FINAL_FORM_MIME_TYPES
const AGREEMENT_FILE_EXTENSIONS = SUB_MERCHANT_FINAL_FORM_EXTENSIONS
const MID_CREATION_QUEUE_SLUG = 'merchant-id'
const TESTING_QUEUE_SLUG = 'testing'
const PHYSICAL_AGREEMENT_QUEUE_SLUG = 'physical-agreement'
const LIVE_QUEUE_SLUG = 'live'
const WORDPRESS_WEBSITE_QUEUE_SLUG = 'wordpress-website'
const WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX = 'wordpress_screenshot_'
const WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX =
  'wordpress_sub_merchant_logo_screenshot_'
const RESUBMISSION_EMAIL_PROOF_KIND = 'resubmission_email_proof'
const AGREEMENT_EMAIL_PROOF_KIND = 'agreement_email_proof'
const MID_CREATION_EMAIL_PROOF_KIND = 'mid_creation_email_proof'
const LIVE_ACTIVATION_EMAIL_PROOF_KIND = 'live_activation_email_proof'
const RESUBMISSION_WHATSAPP_PROOF_KIND = 'resubmission_whatsapp_proof'
const AGREEMENT_WHATSAPP_PROOF_KIND = 'agreement_whatsapp_proof'
const MID_CREATION_WHATSAPP_PROOF_KIND = 'mid_creation_whatsapp_proof'
const LIVE_ACTIVATION_WHATSAPP_PROOF_KIND = 'live_activation_whatsapp_proof'
const EMAIL_PROOF_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
const DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS = [
  'resubmission_email_sent',
  'resubmission_email_sent_manual',
  'resubmission_whatsapp_sent_manual',
] as const
type ManualCommunicationChannel = 'email' | 'whatsapp'
const PHYSICAL_AGREEMENT_FILE_KIND = 'physical_agreement_scanned_copy'
const MAX_PHYSICAL_AGREEMENT_BYTES = 10 * 1024 * 1024
const PHYSICAL_AGREEMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const PHYSICAL_AGREEMENT_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
])
const MAX_WORDPRESS_SCREENSHOT_BYTES = 10 * 1024 * 1024
const WORDPRESS_SCREENSHOT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
const WORDPRESS_SCREENSHOT_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
])

async function getAgentQueueAccess(userId: string) {
  const user = await getDb().query.users.findFirst({
    where: eq(users.id, userId),
    columns: { roleType: true, queueViewScope: true },
  })

  if (!user || user.roleType !== 'agent') {
    return null
  }

  const rows = await getDb()
    .select({
      queueId: userQueueAccess.queueId,
      accessType: userQueueAccess.accessType,
    })
    .from(userQueueAccess)
    .where(eq(userQueueAccess.userId, userId))

  return {
    viewScope: user.queueViewScope,
    viewQueueIds: rows
      .filter((row) => row.accessType === 'view')
      .map((row) => row.queueId),
    workQueueIds: rows
      .filter((row) => row.accessType === 'work')
      .map((row) => row.queueId),
  }
}

async function assertCanViewCase(caseId: string, actor?: SessionUser) {
  if (!actor || actor.roleType !== 'agent') return

  const access = await getAgentQueueAccess(actor.userId)
  if (!access || access.viewScope === 'all') return

  const caseRow = await getDb().query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { queueId: true },
  })

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (!access.viewQueueIds.includes(caseRow.queueId)) {
    throw new AppError(403, 'You do not have access to this queue.')
  }
}

async function assertCanWorkCase(caseId: string, userId: string) {
  const access = await getAgentQueueAccess(userId)
  if (!access) return

  const caseRow = await getDb().query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { queueId: true },
  })

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (!access.workQueueIds.includes(caseRow.queueId)) {
    throw new AppError(403, 'You do not have working access to this queue.')
  }
}

async function assertOwnerCanWorkCases(
  ownerId: string | null,
  caseIds: string[],
) {
  if (!ownerId) return

  const access = await getAgentQueueAccess(ownerId)
  if (!access) return

  const rows = await getDb()
    .select({
      queueId: cases.queueId,
      queueName: queues.name,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(inArray(cases.id, caseIds))

  const workQueueIds = new Set(access.workQueueIds)
  const inaccessibleQueueNames = Array.from(
    new Set(
      rows
        .filter((row) => !workQueueIds.has(row.queueId))
        .map((row) => row.queueName),
    ),
  )

  if (inaccessibleQueueNames.length > 0) {
    throw new AppError(
      403,
      `Selected employee does not have work access to: ${inaccessibleQueueNames.join(', ')}.`,
    )
  }
}

async function assertCaseOwner(caseId: string, userId: string) {
  const caseRow = await getDb().query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { ownerId: true },
  })

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(
      403,
      'Only the current case owner can work on this case.',
    )
  }
}

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

function generatePublicTokenString(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

function parseCsvValues<TValue extends string>(
  rawValue: string,
  allowedValues: ReadonlySet<string>,
) {
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(
      (value): value is TValue => value.length > 0 && allowedValues.has(value),
    )
}

// ─── Case Number Generation ─────────────────────────────────────────────────

type KeysetCursorKind = 'date' | 'number' | 'string'

type DecodedKeysetCursor = {
  sortBy: string
  sortOrder: 'asc' | 'desc'
  value: Date | number | string
  id: string
}

function encodeKeysetCursor(input: {
  sortBy: string
  sortOrder: 'asc' | 'desc'
  value: unknown
  id: string
}) {
  return btoa(
    encodeURIComponent(
      JSON.stringify({
        ...input,
        value:
          input.value instanceof Date ? input.value.toISOString() : input.value,
      }),
    ),
  )
}

function decodeKeysetCursor(
  rawCursor: string,
  expected: {
    sortBy: string
    sortOrder: 'asc' | 'desc'
    kind: KeysetCursorKind
  },
): DecodedKeysetCursor {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(rawCursor))) as {
      sortBy?: unknown
      sortOrder?: unknown
      value?: unknown
      id?: unknown
    }

    if (
      parsed.sortBy !== expected.sortBy ||
      parsed.sortOrder !== expected.sortOrder ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('Cursor does not match the active sort.')
    }

    let value: Date | number | string
    if (expected.kind === 'date') {
      if (typeof parsed.value !== 'string') {
        throw new Error('Cursor date is invalid.')
      }
      value = new Date(parsed.value)
      if (Number.isNaN(value.getTime())) {
        throw new Error('Cursor date is invalid.')
      }
    } else if (expected.kind === 'number') {
      value = Number(parsed.value)
      if (!Number.isFinite(value)) {
        throw new Error('Cursor number is invalid.')
      }
    } else {
      if (typeof parsed.value !== 'string') {
        throw new Error('Cursor value is invalid.')
      }
      value = parsed.value
    }

    return {
      sortBy: expected.sortBy,
      sortOrder: expected.sortOrder,
      value,
      id: parsed.id,
    }
  } catch {
    throw new AppError(400, 'Invalid pagination cursor.')
  }
}

function buildKeysetCondition(input: {
  expression: unknown
  idExpression: unknown
  sortOrder: 'asc' | 'desc'
  value: Date | number | string
  id: string
}) {
  const operator = input.sortOrder === 'desc' ? '<' : '>'
  return or(
    sql`${input.expression} ${sql.raw(operator)} ${input.value}`,
    and(
      sql`${input.expression} = ${input.value}`,
      sql`${input.idExpression} ${sql.raw(operator)} ${input.id}`,
    ),
  )!
}

async function generateCaseNumber(
  tx: DbTransaction,
  queueId: string,
): Promise<string> {
  // Get queue prefix
  const queue = await tx.query.queues.findFirst({
    where: eq(queues.id, queueId),
    columns: { prefix: true },
  })

  if (!queue) {
    throw new AppError(404, 'Queue not found.')
  }

  await tx
    .insert(queueCaseSequences)
    .values({ queueId, lastNumber: 0 })
    .onConflictDoNothing()

  // Atomically increment the sequence counter
  const [updated] = await tx
    .update(queueCaseSequences)
    .set({
      lastNumber: sql`${queueCaseSequences.lastNumber} + 1`,
    })
    .where(eq(queueCaseSequences.queueId, queueId))
    .returning({ lastNumber: queueCaseSequences.lastNumber })

  if (!updated) {
    throw new AppError(
      500,
      'Failed to generate case number. Queue sequence not found.',
    )
  }

  const paddedNumber = String(updated.lastNumber).padStart(9, '0')
  return `${queue.prefix}-${paddedNumber}`
}

async function getTestingLimitsAppliedEntry(caseId: string) {
  const db = getDb()
  const [entry] = await db
    .select({
      createdAt: caseHistory.createdAt,
      actorId: caseHistory.actorId,
      actorName: users.name,
    })
    .from(caseHistory)
    .leftJoin(users, eq(caseHistory.actorId, users.id))
    .where(
      and(
        eq(caseHistory.caseId, caseId),
        eq(caseHistory.action, 'testing_limits_applied'),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  return entry ?? null
}

async function getLiveLimitsAppliedEntry(caseId: string) {
  const db = getDb()
  const [entry] = await db
    .select({
      createdAt: caseHistory.createdAt,
      actorId: caseHistory.actorId,
      actorName: users.name,
    })
    .from(caseHistory)
    .leftJoin(users, eq(caseHistory.actorId, users.id))
    .where(
      and(
        eq(caseHistory.caseId, caseId),
        eq(caseHistory.action, 'live_limits_applied'),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  return entry ?? null
}

async function getDocumentReviewResubmissionSentEntry(caseId: string) {
  const [entry] = await getDb()
    .select({ id: caseHistory.id })
    .from(caseHistory)
    .where(
      and(
        eq(caseHistory.caseId, caseId),
        inArray(caseHistory.action, DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS),
      ),
    )
    .limit(1)

  return entry ?? null
}

async function getWordpressWebsiteDetails(caseId: string) {
  const db = getDb()
  const [savedEntry] = await db
    .select({
      createdAt: caseHistory.createdAt,
      actorId: caseHistory.actorId,
      actorName: users.name,
      details: caseHistory.details,
    })
    .from(caseHistory)
    .leftJoin(users, eq(caseHistory.actorId, users.id))
    .where(
      and(
        eq(caseHistory.caseId, caseId),
        eq(caseHistory.action, 'wordpress_website_saved'),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  const screenshotRows = await db
    .select({
      id: caseFiles.id,
      originalName: caseFiles.originalName,
      mimeType: caseFiles.mimeType,
      sizeBytes: caseFiles.sizeBytes,
      googleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
      googleDriveDownloadLink: caseFiles.googleDriveDownloadLink,
      createdAt: caseFiles.createdAt,
    })
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.caseId, caseId),
        ilike(caseFiles.fileKind, `${WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX}%`),
      ),
    )
    .orderBy(asc(caseFiles.fileKind))

  const subMerchantLogoScreenshotRows = await db
    .select({
      id: caseFiles.id,
      originalName: caseFiles.originalName,
      mimeType: caseFiles.mimeType,
      sizeBytes: caseFiles.sizeBytes,
      googleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
      googleDriveDownloadLink: caseFiles.googleDriveDownloadLink,
      createdAt: caseFiles.createdAt,
    })
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
    .orderBy(asc(caseFiles.fileKind))

  const details = savedEntry?.details as {
    clonedWebsiteLink?: unknown
  } | null

  return {
    clonedWebsiteLink:
      typeof details?.clonedWebsiteLink === 'string'
        ? details.clonedWebsiteLink
        : null,
    savedAt: savedEntry?.createdAt?.toISOString() ?? null,
    savedBy: savedEntry?.actorId
      ? {
          id: savedEntry.actorId,
          name: savedEntry.actorName ?? 'Unknown',
        }
      : null,
    screenshots: screenshotRows,
    subMerchantLogoScreenshots: subMerchantLogoScreenshotRows,
  }
}

async function getLatestWordpressWebsiteDetailsForMerchant(merchantId: string) {
  const [latestWordpressCase] = await getDb()
    .select({
      caseId: cases.id,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(caseHistory, eq(caseHistory.caseId, cases.id))
    .where(
      and(
        eq(cases.merchantId, merchantId),
        eq(queues.slug, WORDPRESS_WEBSITE_QUEUE_SLUG),
        eq(caseHistory.action, 'wordpress_website_saved'),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  return latestWordpressCase
    ? getWordpressWebsiteDetails(latestWordpressCase.caseId)
    : null
}

async function getDocumentReviewDetails(caseId: string) {
  const [details] = await getDb()
    .select({
      subMerchantId: documentReviewDetails.subMerchantId,
      subMerchantName: documentReviewDetails.subMerchantName,
      selectedAt: documentReviewDetails.updatedAt,
      selectedById: documentReviewDetails.selectedBy,
      selectedByName: users.name,
    })
    .from(documentReviewDetails)
    .leftJoin(users, eq(documentReviewDetails.selectedBy, users.id))
    .where(eq(documentReviewDetails.caseId, caseId))
    .limit(1)

  if (!details) return null

  return {
    subMerchantId: details.subMerchantId,
    subMerchantName: details.subMerchantName,
    selectedAt: details.selectedAt.toISOString(),
    selectedBy: details.selectedById
      ? {
          id: details.selectedById,
          name: details.selectedByName ?? 'Unknown',
        }
      : null,
  }
}

async function getLatestDocumentReviewDetailsForMerchant(merchantId: string) {
  const [details] = await getDb()
    .select({
      subMerchantId: documentReviewDetails.subMerchantId,
      subMerchantName: documentReviewDetails.subMerchantName,
      selectedAt: documentReviewDetails.updatedAt,
      selectedById: documentReviewDetails.selectedBy,
      selectedByName: users.name,
    })
    .from(documentReviewDetails)
    .innerJoin(cases, eq(documentReviewDetails.caseId, cases.id))
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .leftJoin(users, eq(documentReviewDetails.selectedBy, users.id))
    .where(
      and(
        eq(cases.merchantId, merchantId),
        eq(queues.slug, 'documents-review'),
      ),
    )
    .orderBy(desc(documentReviewDetails.updatedAt))
    .limit(1)

  if (!details) return null

  return {
    subMerchantId: details.subMerchantId,
    subMerchantName: details.subMerchantName,
    selectedAt: details.selectedAt.toISOString(),
    selectedBy: details.selectedById
      ? {
          id: details.selectedById,
          name: details.selectedByName ?? 'Unknown',
        }
      : null,
  }
}

async function getSubMerchantFormDetails(caseId: string) {
  const rows = await getDb()
    .select({
      subMerchantKey: subMerchantFormDetails.subMerchantKey,
      subMerchantName: subMerchantFormDetails.subMerchantName,
      draftUrl: subMerchantFormDetails.draftUrl,
      emailStatus: subMerchantFormDetails.emailStatus,
      emailLogId: subMerchantFormDetails.emailLogId,
      emailSentAt: subMerchantFormDetails.emailSentAt,
      emailRecipient: subMerchantFormDetails.emailRecipient,
      finalFormId: caseFiles.id,
      finalFormOriginalName: caseFiles.originalName,
      finalFormMimeType: caseFiles.mimeType,
      finalFormSizeBytes: caseFiles.sizeBytes,
      finalFormGoogleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
      finalFormGoogleDriveDownloadLink: caseFiles.googleDriveDownloadLink,
      finalFormCreatedAt: caseFiles.createdAt,
    })
    .from(subMerchantFormDetails)
    .leftJoin(
      caseFiles,
      eq(subMerchantFormDetails.finalFormFileId, caseFiles.id),
    )
    .where(eq(subMerchantFormDetails.caseId, caseId))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const [subMerchant, emailProof] = await Promise.all([
    getDb().query.subMerchantDraftTemplates.findFirst({
      where: eq(subMerchantDraftTemplates.id, row.subMerchantKey),
      columns: { sellerCode: true },
    }),
    getDb().query.caseFiles.findFirst({
      where: and(
        eq(caseFiles.caseId, caseId),
        eq(caseFiles.fileKind, SUB_MERCHANT_EMAIL_PROOF_KIND),
      ),
    }),
  ])

  return {
    ...row,
    sellerCode: subMerchant?.sellerCode ?? null,
    emailProofId: emailProof?.id ?? null,
    emailProofOriginalName: emailProof?.originalName ?? null,
    emailProofMimeType: emailProof?.mimeType ?? null,
    emailProofSizeBytes: emailProof?.sizeBytes ?? null,
    emailProofGoogleDriveWebViewLink:
      emailProof?.googleDriveWebViewLink ?? null,
    emailProofGoogleDriveDownloadLink:
      emailProof?.googleDriveDownloadLink ?? null,
    emailProofCreatedAt: emailProof?.createdAt ?? null,
  }
}

async function ensureInheritedSubMerchantFormDetails(input: {
  caseId: string
  merchantId: string
  actorId?: string | null
}) {
  const db = getDb()
  const existing = await getSubMerchantFormDetails(input.caseId)
  if (existing) return existing

  const documentReviewDetail = await getLatestDocumentReviewDetailsForMerchant(
    input.merchantId,
  )
  if (!documentReviewDetail) return null

  const subMerchant = await db.query.subMerchantDraftTemplates.findFirst({
    where: eq(subMerchantDraftTemplates.id, documentReviewDetail.subMerchantId),
    columns: {
      id: true,
      name: true,
      googleDriveWebViewLink: true,
    },
  })

  if (!subMerchant) return null

  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .insert(subMerchantFormDetails)
      .values({
        caseId: input.caseId,
        subMerchantKey: subMerchant.id,
        subMerchantName: subMerchant.name,
        draftUrl: subMerchant.googleDriveWebViewLink,
        emailStatus: 'not_sent',
        emailLogId: null,
        emailSentAt: null,
        emailRecipient: null,
        updatedAt: now,
      })
      .onConflictDoNothing()

    await tx.insert(caseHistory).values({
      caseId: input.caseId,
      actorId: input.actorId ?? null,
      action: 'sub_merchant_inherited',
      details: {
        subMerchantKey: subMerchant.id,
        subMerchantName: subMerchant.name,
      },
      createdAt: now,
    })
  })

  return getSubMerchantFormDetails(input.caseId)
}

async function getMidCreationPortalMid(
  merchantId: string,
): Promise<number | null> {
  const credentials = await getMidCreationCredentials(merchantId)
  return credentials?.portalMid ?? null
}

type MidCreationCredentials = {
  portalMid: number
  portalMuid: string | null
  email: string
  password: string
  paymentMethods: PaymentMethodSettings
  payoutMethods: PaymentMethodSettings
}

async function getMidCreationCredentials(
  merchantId: string,
): Promise<MidCreationCredentials | null> {
  const db = getDb()
  const [entry] = await db
    .select({ details: caseHistory.details })
    .from(caseHistory)
    .innerJoin(cases, eq(caseHistory.caseId, cases.id))
    .where(
      and(
        eq(cases.merchantId, merchantId),
        eq(caseHistory.action, 'mid_creation_saved'),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  if (!entry) return null
  const details = entry.details as {
    portalMid?: unknown
    portalMuid?: unknown
    email?: unknown
    password?: unknown
    paymentMethods?: unknown
    payoutMethods?: unknown
  } | null
  if (
    typeof details?.portalMid !== 'number' ||
    typeof details.email !== 'string' ||
    typeof details.password !== 'string'
  ) {
    return null
  }

  const parsedPaymentMethods = paymentMethodSettingsSchema.safeParse(
    details.paymentMethods,
  )
  const parsedPayoutMethods = paymentMethodSettingsSchema.safeParse(
    details.payoutMethods,
  )

  return {
    portalMid: details.portalMid,
    portalMuid:
      typeof details.portalMuid === 'string' ? details.portalMuid : null,
    email: details.email,
    password: details.password,
    paymentMethods: parsedPaymentMethods.success
      ? parsedPaymentMethods.data
      : (parseLegacyMethodSettings(details.paymentMethods, 'collection') ??
        defaultPaymentMethodSettings),
    payoutMethods: parsedPayoutMethods.success
      ? parsedPayoutMethods.data
      : (parseLegacyMethodSettings(details.paymentMethods, 'disbursement') ??
        defaultPayoutMethodSettings),
  }
}

function parseLegacyMethodSettings(
  value: unknown,
  mode: 'collection' | 'disbursement',
) {
  const legacyMethods = Array.isArray(value) ? value : []
  const migrated = legacyMethods.flatMap((method) => {
    if (!method || typeof method !== 'object') return []
    const record = method as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const id =
      typeof record.key === 'string' && record.key.trim()
        ? record.key.trim()
        : label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const enabled =
      mode === 'collection'
        ? record.collectionEnabled !== false
        : record.disbursementEnabled !== false

    return label && id && enabled ? [{ id, label }] : []
  })
  const parsed = paymentMethodSettingsSchema.safeParse(migrated)
  return parsed.success ? parsed.data : null
}

function getCaseDetailMerchant(input: {
  merchant: Merchant
  queueSlug: string
  ownerId: string | null
  actor?: SessionUser
}) {
  if (
    input.queueSlug !== MID_CREATION_QUEUE_SLUG ||
    input.actor?.userId === input.ownerId
  ) {
    return input.merchant
  }

  const merchant = { ...input.merchant } as Record<string, unknown>
  delete merchant.bankName
  delete merchant.accountNumberIban
  return merchant
}

// ─── Create Case ────────────────────────────────────────────────────────────

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
        qcEnabled: true,
        isActive: true,
      },
    })

    if (!queue) {
      throw new AppError(404, 'Queue not found.')
    }

    if (!queue.isActive) {
      throw new AppError(
        409,
        'This queue is inactive. Case creation is disabled.',
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

    if (actorId) {
      await tx.insert(caseHistory).values({
        caseId: created.id,
        actorId,
        action: 'case_created_manually',
        details: {
          queueName: queue.name,
          merchantName: merchant.businessName,
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

function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.[^.]+$/)
  return match?.[0] ?? ''
}

function validateSubMerchantFinalFormFile(file: File) {
  if (file.size > MAX_SUB_MERCHANT_FINAL_FORM_BYTES) {
    throw new AppError(400, 'Final Form must be 1 MB or smaller.')
  }

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !SUB_MERCHANT_FINAL_FORM_EXTENSIONS.has(extension) ||
    !SUB_MERCHANT_FINAL_FORM_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(400, 'Final Form must be a PDF, DOC, or DOCX file.')
  }
}

function validateWordpressScreenshotFile(file: File) {
  if (file.size > MAX_WORDPRESS_SCREENSHOT_BYTES) {
    throw new AppError(400, 'Each screenshot must be 10 MB or smaller.')
  }

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !WORDPRESS_SCREENSHOT_EXTENSIONS.has(extension) ||
    !WORDPRESS_SCREENSHOT_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(400, 'Screenshots must be JPG, PNG, or WEBP files.')
  }
}

function buildCaseUploadFolderName(caseNumber: string, merchantName: string) {
  const safeMerchantName = merchantName
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

  return `${caseNumber} - ${safeMerchantName || 'Merchant'}`
}

// ─── List Case Owners ───────────────────────────────────────────────────────

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

export async function bulkAssignCases(
  caseIds: string[],
  ownerId: string | null,
  actorId: string,
) {
  const db = getDb()
  const uniqueCaseIds = Array.from(new Set(caseIds))
  const nextOwner = ownerId
    ? await db.query.users.findFirst({
        where: eq(users.id, ownerId),
        columns: { id: true, name: true, status: true },
      })
    : null

  if (ownerId && !nextOwner) {
    throw new AppError(404, 'User not found.')
  }
  if (nextOwner && nextOwner.status !== 'active') {
    throw new AppError(403, 'Inactive employees cannot own cases.')
  }

  const existingCases = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      ownerName: users.name,
      queueId: cases.queueId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
      closedAt: cases.closedAt,
      currentStageId: cases.currentStageId,
      currentStageName: queueStages.name,
      currentStageCategory: queueStages.category,
    })
    .from(cases)
    .leftJoin(users, eq(cases.ownerId, users.id))
    .leftJoin(queueStages, eq(cases.currentStageId, queueStages.id))
    .where(inArray(cases.id, uniqueCaseIds))

  if (existingCases.length !== uniqueCaseIds.length) {
    throw new AppError(404, 'One or more cases were not found.')
  }

  const closedCase = existingCases.find(
    (caseRecord) =>
      caseRecord.status === 'closed' ||
      caseRecord.status === 'error' ||
      caseRecord.currentStageCategory === 'closed' ||
      Boolean(caseRecord.closeOutcome) ||
      Boolean(caseRecord.closedAt),
  )
  if (closedCase) {
    throw new AppError(400, 'Closed cases cannot be assigned or transferred.')
  }

  await assertOwnerCanWorkCases(ownerId, uniqueCaseIds)

  const stageRows = await db
    .select({
      id: queueStages.id,
      queueId: queueStages.queueId,
      name: queueStages.name,
      slug: queueStages.slug,
      category: queueStages.category,
    })
    .from(queueStages)
    .where(
      inArray(
        queueStages.queueId,
        existingCases.map((item) => item.queueId),
      ),
    )

  const stageByQueue = new Map<
    string,
    {
      newStageId: string
      workingStageId: string
      newStageName: string
      workingStageName: string
    }
  >()
  for (const caseRecord of existingCases) {
    const queueStageRows = stageRows.filter(
      (stage) => stage.queueId === caseRecord.queueId,
    )
    const newStage = queueStageRows.find((stage) => stage.category === 'new')
    const workingStage = queueStageRows.find(
      (stage) => stage.slug === 'working',
    )
    if (!newStage || !workingStage) {
      throw new AppError(
        500,
        'Required New and Working stages are not configured.',
      )
    }
    stageByQueue.set(caseRecord.queueId, {
      newStageId: newStage.id,
      workingStageId: workingStage.id,
      newStageName: newStage.name,
      workingStageName: workingStage.name,
    })
  }

  const updatedCases = await db.transaction(async (tx) => {
    const changedCases = existingCases.filter(
      (caseRecord) => caseRecord.ownerId !== ownerId,
    )

    for (const caseRecord of changedCases) {
      const stages = stageByQueue.get(caseRecord.queueId)
      if (!stages) throw new AppError(500, 'Queue stages are not configured.')

      const shouldStartWorking =
        ownerId !== null && caseRecord.currentStageCategory === 'new'
      const updateData =
        ownerId === null
          ? {
              ownerId: null,
              currentStageId: stages.newStageId,
              status: 'new' as const,
              closeOutcome: null,
              closeReason: null,
              closedAt: null,
              slaBreached: null,
              updatedAt: new Date(),
            }
          : {
              ownerId,
              ...(shouldStartWorking
                ? {
                    currentStageId: stages.workingStageId,
                    status: 'working' as const,
                  }
                : {}),
              updatedAt: new Date(),
            }

      await tx.update(cases).set(updateData).where(eq(cases.id, caseRecord.id))

      await tx.insert(caseHistory).values({
        caseId: caseRecord.id,
        actorId,
        action:
          ownerId === null
            ? 'owner_unassigned'
            : caseRecord.ownerId
              ? 'owner_transferred'
              : 'owner_assigned',
        details: {
          fromOwner: caseRecord.ownerName ?? 'AP System',
          toOwner: nextOwner?.name ?? 'AP System',
          fromStage: caseRecord.currentStageName,
          toStage:
            ownerId === null
              ? stages.newStageName
              : shouldStartWorking
                ? stages.workingStageName
                : caseRecord.currentStageName,
        },
      })
    }

    return changedCases
  })

  if (updatedCases.length > 0) {
    // Notifications (best-effort) for each affected case
    try {
      const actor = await db.query.users.findFirst({
        where: eq(users.id, actorId),
        columns: { name: true },
      })
      const affectedIds = updatedCases.map((item) => item.id)
      const metas = await db
        .select({
          id: cases.id,
          caseNumber: cases.caseNumber,
          queueName: queues.name,
        })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(inArray(cases.id, affectedIds))
      const metaById = new Map(metas.map((m) => [m.id, m]))
      const previousById = new Map(
        existingCases.map((c) => [c.id, c.ownerId ?? null]),
      )
      await Promise.all(
        affectedIds.map((cid) => {
          const meta = metaById.get(cid)
          if (!meta) return Promise.resolve()
          return notifyAssignment({
            caseId: cid,
            caseNumber: meta.caseNumber,
            queueName: meta.queueName,
            actorId,
            actorName: actor?.name ?? 'Someone',
            newOwnerId: ownerId,
            previousOwnerId: previousById.get(cid) ?? null,
          })
        }),
      )
    } catch (error) {
      console.error('[notifications] bulkAssignCases notify failed', error)
    }
  }

  return { updated: updatedCases.length }
}

// ─── Update Case Status ─────────────────────────────────────────────────────

export async function updateCaseStatus(
  caseId: string,
  userId: string,
  input: UpdateCaseStatusInput,
) {
  const db = getDb()
  await assertCaseOwner(caseId, userId)

  const [existing] = await db
    .select({
      id: cases.id,
      status: cases.status,
      merchantId: cases.merchantId,
      queueId: cases.queueId,
      createdAt: cases.createdAt,
      queueSlaHours: queues.slaHours,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const currentStatus = existing.status as CaseStatusValue

  if (!isValidStatusTransition(currentStatus, input.status)) {
    throw new AppError(
      400,
      `Invalid status transition from "${currentStatus}" to "${input.status}".`,
    )
  }

  const updateData: Record<string, unknown> = {
    status: input.status,
    updatedAt: new Date(),
  }

  // Auto-set closedAt when transitioning to closed
  if (input.status === 'closed' || input.status === 'error') {
    const closedAt = new Date()
    updateData.closedAt = closedAt
    updateData.slaBreached = isCaseSlaBreached({
      createdAt: existing.createdAt,
      evaluatedAt: closedAt,
      slaHours: existing.queueSlaHours,
    })
  }

  // Clear closedAt when re-opening from closed
  if (
    (currentStatus === 'closed' || currentStatus === 'error') &&
    input.status !== 'closed' &&
    input.status !== 'error'
  ) {
    updateData.closedAt = null
    updateData.slaBreached = null
  }

  const [updated] = await db.transaction(async (tx) => {
    if (input.status === 'closed') {
      await assertCloseBlockersSatisfied(tx, {
        merchantId: existing.merchantId,
        queueId: existing.queueId,
      })
    }

    return tx
      .update(cases)
      .set(updateData)
      .where(eq(cases.id, caseId))
      .returning({
        id: cases.id,
        status: cases.status,
        slaBreached: cases.slaBreached,
        closedAt: cases.closedAt,
        updatedAt: cases.updatedAt,
      })
  })

  if (!updated) {
    throw new AppError(500, 'Failed to update case status.')
  }

  return updated
}

// ─── Assign Case ────────────────────────────────────────────────────────────

export async function assignCase(
  caseId: string,
  ownerId: string | null,
  actorId: string,
) {
  const db = getDb()
  const nextOwner = ownerId
    ? await db.query.users.findFirst({
        where: eq(users.id, ownerId),
        columns: { id: true, name: true, status: true },
      })
    : null

  // Verify case exists
  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      ownerName: users.name,
      queueId: cases.queueId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
      closedAt: cases.closedAt,
      currentStageId: cases.currentStageId,
      currentStageName: queueStages.name,
      currentStageCategory: queueStages.category,
    })
    .from(cases)
    .leftJoin(users, eq(cases.ownerId, users.id))
    .leftJoin(queueStages, eq(cases.currentStageId, queueStages.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  const existingCase = existing[0]

  if (!existingCase) {
    throw new AppError(404, 'Case not found.')
  }

  if (
    existingCase.status === 'closed' ||
    existingCase.status === 'error' ||
    existingCase.currentStageCategory === 'closed' ||
    Boolean(existingCase.closeOutcome) ||
    Boolean(existingCase.closedAt)
  ) {
    throw new AppError(400, 'Closed cases cannot be assigned or transferred.')
  }

  if (ownerId && !nextOwner) {
    throw new AppError(404, 'User not found.')
  }
  if (nextOwner && nextOwner.status !== 'active') {
    throw new AppError(403, 'Inactive employees cannot own cases.')
  }

  if (existingCase.ownerId === ownerId) {
    return {
      id: existingCase.id,
      ownerId: existingCase.ownerId,
      updatedAt: new Date(),
    }
  }

  await assertOwnerCanWorkCases(ownerId, [caseId])

  const stageRows = await db
    .select()
    .from(queueStages)
    .where(eq(queueStages.queueId, existingCase.queueId))
  const newStage = stageRows.find((stage) => stage.category === 'new')
  const workingStage = stageRows.find((stage) => stage.slug === 'working')
  if (!newStage || !workingStage) {
    throw new AppError(
      500,
      'Required New and Working stages are not configured.',
    )
  }

  const shouldStartWorking =
    ownerId !== null && existingCase.currentStageCategory === 'new'
  const updateData =
    ownerId === null
      ? {
          ownerId: null,
          currentStageId: newStage.id,
          status: 'new' as const,
          closeOutcome: null,
          closeReason: null,
          closedAt: null,
          slaBreached: null,
          updatedAt: new Date(),
        }
      : {
          ownerId,
          ...(shouldStartWorking
            ? {
                currentStageId: workingStage.id,
                status: 'working' as const,
              }
            : {}),
          updatedAt: new Date(),
        }

  const [updated] = await db.transaction(async (tx) => {
    const updatedRows = await tx
      .update(cases)
      .set(updateData)
      .where(eq(cases.id, caseId))
      .returning({
        id: cases.id,
        ownerId: cases.ownerId,
        updatedAt: cases.updatedAt,
      })

    await tx.insert(caseHistory).values({
      caseId,
      actorId,
      action:
        ownerId === null
          ? 'owner_unassigned'
          : existingCase.ownerId
            ? 'owner_transferred'
            : 'owner_assigned',
      details: {
        fromOwner: existingCase.ownerName ?? 'AP System',
        toOwner: nextOwner?.name ?? 'AP System',
        fromStage: existingCase.currentStageName,
        toStage:
          ownerId === null
            ? newStage.name
            : shouldStartWorking
              ? workingStage.name
              : existingCase.currentStageName,
      },
    })

    return updatedRows
  })

  if (!updated) {
    throw new AppError(500, 'Failed to assign case.')
  }

  if (existingCase.ownerId !== ownerId) {
    // Notifications (best-effort)
    try {
      const meta = await db
        .select({ caseNumber: cases.caseNumber, queueName: queues.name })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(eq(cases.id, caseId))
        .limit(1)
      const actor = await db.query.users.findFirst({
        where: eq(users.id, actorId),
        columns: { name: true },
      })
      if (meta[0]) {
        await notifyAssignment({
          caseId,
          caseNumber: meta[0].caseNumber,
          queueName: meta[0].queueName,
          actorId,
          actorName: actor?.name ?? 'Someone',
          newOwnerId: ownerId,
          previousOwnerId: existingCase.ownerId ?? null,
        })
      }
    } catch (error) {
      console.error('[notifications] assignCase notify failed', error)
    }
  }

  return updated
}

// ─── Update Case Priority ────────────────────────────────────────────────────

export async function updateCasePriority(
  caseId: string,
  priority: 'normal' | 'high',
) {
  const db = getDb()

  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const [updated] = await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(eq(cases.id, caseId))
    .returning({
      id: cases.id,
      priority: cases.priority,
      updatedAt: cases.updatedAt,
    })

  if (!updated) {
    throw new AppError(500, 'Failed to update case priority.')
  }

  return updated
}

// ─── Cascade Merchant Priority to Cases ──────────────────────────────────────

export async function cascadeMerchantPriority(
  merchantId: string,
  priority: 'normal' | 'high',
) {
  const db = getDb()

  await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(eq(cases.merchantId, merchantId))
}

// ─── Get Case Detail ────────────────────────────────────────────────────────

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

  // Fetch all related data in parallel
  const [
    queue,
    stagesResult,
    merchantRow,
    documents,
    fieldReviews,
    latestResubmissionEntry,
    subMerchantForm,
    agreement,
    testingLimitsAppliedEntry,
    liveLimitsAppliedEntry,
    wordpressWebsiteDetails,
    merchantWordpressWebsiteDetails,
    caseDocumentReviewDetail,
    merchantDocumentReviewDetail,
    midCreationCredentials,
    paymentMethods,
    payoutMethods,
  ] = await Promise.all([
    db.query.queues.findFirst({
      where: eq(queues.id, caseData.queueId),
    }),
    db
      .select()
      .from(queueStages)
      .where(eq(queueStages.queueId, caseData.queueId))
      .orderBy(asc(queueStages.order)),
    db.query.merchants.findFirst({
      where: eq(merchants.id, caseData.merchantId),
    }),
    db
      .select()
      .from(merchantDocuments)
      .where(eq(merchantDocuments.merchantId, caseData.merchantId)),
    db
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
      .where(eq(caseFieldReviews.caseId, caseId)),
    db
      .select({
        createdAt: caseHistory.createdAt,
      })
      .from(caseHistory)
      .where(
        and(
          eq(caseHistory.caseId, caseId),
          inArray(caseHistory.action, DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS),
        ),
      )
      .orderBy(desc(caseHistory.createdAt))
      .limit(1)
      .then((rows: Array<{ createdAt: Date }>) => rows[0] ?? null),
    getSubMerchantFormDetails(caseId),
    db
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
        finalAgreementGoogleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
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
      .then((rows) => rows[0] ?? null),
    getTestingLimitsAppliedEntry(caseId),
    getLiveLimitsAppliedEntry(caseId),
    getWordpressWebsiteDetails(caseId),
    getLatestWordpressWebsiteDetailsForMerchant(caseData.merchantId),
    getDocumentReviewDetails(caseId),
    getLatestDocumentReviewDetailsForMerchant(caseData.merchantId),
    getMidCreationCredentials(caseData.merchantId),
    getPaymentMethodSettings(),
    getPayoutMethodSettings(),
  ])

  if (!queue || !merchantRow) {
    throw new AppError(500, 'Case data integrity error.')
  }

  const merchant = merchantRow
  const merchantForDetail = getCaseDetailMerchant({
    merchant: merchantRow,
    queueSlug: queue.slug,
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
        })

  const stages = getVisibleStagesForQueue(queue.slug, seededStages)

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
  if (!agreementRecord && queue.slug === AGREEMENT_QUEUE_SLUG) {
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

    agreementRecord = createdAgreement
      ? {
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
      : null
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
    queue.slug === PHYSICAL_AGREEMENT_QUEUE_SLUG
      ? await db.query.caseFiles.findFirst({
          where: and(
            eq(caseFiles.caseId, caseId),
            eq(caseFiles.fileKind, PHYSICAL_AGREEMENT_FILE_KIND),
          ),
        })
      : null
  const documentReviewDetail =
    queue.slug === WORDPRESS_WEBSITE_QUEUE_SLUG
      ? merchantDocumentReviewDetail
      : caseDocumentReviewDetail
  const resolvedWordpressWebsiteDetails =
    queue.slug === SUB_MERCHANT_FORM_QUEUE_SLUG
      ? (merchantWordpressWebsiteDetails ?? wordpressWebsiteDetails)
      : wordpressWebsiteDetails
  const subMerchantFormRecord =
    queue.slug === SUB_MERCHANT_FORM_QUEUE_SLUG
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
      credentialsReady: Boolean(midCreationCredentials),
      portalMid:
        queue.slug === MID_CREATION_QUEUE_SLUG
          ? (midCreationCredentials?.portalMid ?? null)
          : null,
      portalMuid:
        queue.slug === MID_CREATION_QUEUE_SLUG ||
        queue.slug === WORDPRESS_WEBSITE_QUEUE_SLUG
          ? (midCreationCredentials?.portalMuid ?? null)
          : null,
      paymentMethods:
        queue.slug === MID_CREATION_QUEUE_SLUG
          ? (midCreationCredentials?.paymentMethods ?? paymentMethods)
          : null,
      payoutMethods:
        queue.slug === MID_CREATION_QUEUE_SLUG
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

export async function takeOwnership(caseId: string, userId: string) {
  const db = getDb()
  await assertCanWorkCase(caseId, userId)
  const actor = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  })

  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
      closedAt: cases.closedAt,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (
    caseData.status === 'closed' ||
    caseData.status === 'error' ||
    Boolean(caseData.closeOutcome) ||
    Boolean(caseData.closedAt)
  ) {
    throw new AppError(400, 'Closed cases cannot be assigned or transferred.')
  }

  if (caseData.ownerId) {
    throw new AppError(400, 'Case already has an owner.')
  }

  // Verify current stage is category 'new'
  const currentStage = caseData.currentStageId
    ? await db.query.queueStages.findFirst({
        where: eq(queueStages.id, caseData.currentStageId),
      })
    : null

  if (!currentStage || currentStage.category !== 'new') {
    throw new AppError(400, 'Case is not in the initial stage.')
  }

  // Find next stage (first in_progress stage)
  const nextStage =
    currentStage.slug === 'new'
      ? await db.query.queueStages.findFirst({
          where: and(
            eq(queueStages.queueId, caseData.queueId),
            eq(queueStages.slug, 'working'),
          ),
        })
      : await db.query.queueStages.findFirst({
          where: and(
            eq(queueStages.queueId, caseData.queueId),
            gt(queueStages.order, currentStage.order),
          ),
          orderBy: asc(queueStages.order),
        })

  if (!nextStage) {
    throw new AppError(500, 'No next stage configured for this queue.')
  }

  const newStatus = getStatusForStage(nextStage)

  const [updated] = await db.transaction(async (tx) => {
    const updatedRows = await tx
      .update(cases)
      .set({
        ownerId: userId,
        currentStageId: nextStage.id,
        status: newStatus,
        updatedAt: new Date(),
      })
      .where(and(eq(cases.id, caseId), isNull(cases.ownerId)))
      .returning()

    if (!updatedRows[0]) {
      throw new AppError(409, 'Case was assigned by another user.')
    }

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'ownership_taken',
      details: {
        fromStage: currentStage.name,
        toStage: nextStage.name,
        fromOwner: 'Unassigned',
        toOwner: actor?.name ?? 'Assigned',
      },
    })

    return updatedRows
  })

  return updated
}

// ─── Advance Stage ──────────────────────────────────────────────────────────

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

  const currentStage = await db.query.queueStages.findFirst({
    where: eq(queueStages.id, caseData.currentStageId),
  })

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Case can only be advanced from an in-progress stage.',
    )
  }

  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, caseData.queueId),
    columns: { qcEnabled: true, slug: true, slaHours: true },
  })

  let targetStage = null

  if (queue?.slug === 'documents-review') {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'Documents-review cases can only be closed successfully from working.',
      )
    }

    const documentReviewDetail = await getDocumentReviewDetails(caseId)
    if (!documentReviewDetail?.subMerchantName) {
      throw new AppError(400, 'Select a sub-merchant before closing this case.')
    }

    const resubmissionSentEntry =
      await getDocumentReviewResubmissionSentEntry(caseId)
    if (!resubmissionSentEntry) {
      throw new AppError(
        400,
        'Send the resubmission request by auto email, manual Gmail, or WhatsApp before closing this case.',
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
  } else if (queue?.slug === SUB_MERCHANT_FORM_QUEUE_SLUG) {
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
  } else if (queue?.slug === AGREEMENT_QUEUE_SLUG) {
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

    if (!details.clientAgreementFileId) {
      throw new AppError(
        400,
        'Client must submit the agreement before closing this case.',
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
  } else if (queue?.slug === MID_CREATION_QUEUE_SLUG) {
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
        'Save the merchant portal credentials before closing this case.',
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
  } else if (queue?.slug === TESTING_QUEUE_SLUG) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'Testing cases can only be closed successfully from working.',
      )
    }

    const limitsAppliedEntry = await getTestingLimitsAppliedEntry(caseId)
    if (!limitsAppliedEntry) {
      throw new AppError(
        400,
        'Confirm testing limits were applied before closing this case.',
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
  } else if (queue?.slug === PHYSICAL_AGREEMENT_QUEUE_SLUG) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(
        400,
        'Physical Agreement cases can only be closed successfully from working.',
      )
    }

    const physicalAgreement = await db.query.caseFiles.findFirst({
      where: and(
        eq(caseFiles.caseId, caseId),
        eq(caseFiles.fileKind, PHYSICAL_AGREEMENT_FILE_KIND),
      ),
    })
    if (!physicalAgreement) {
      throw new AppError(
        400,
        'Upload the physical signed agreement copy before closing this case.',
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
  } else if (queue?.slug === LIVE_QUEUE_SLUG) {
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
  } else if (queue?.slug === WORDPRESS_WEBSITE_QUEUE_SLUG) {
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

    if (details.subMerchantLogoScreenshots.length === 0) {
      throw new AppError(
        400,
        'Upload the sub-merchant website logo screenshot before closing this case.',
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

  const updateData: Record<string, unknown> = {
    currentStageId: targetStage.id,
    status: newStatus,
    updatedAt: now,
  }

  // If advancing to closed, mark successful
  if (targetStage.category === 'closed') {
    updateData.closeOutcome = 'successful'
    updateData.closeReason = null
    updateData.closedAt = now
    updateData.slaBreached = isCaseSlaBreached({
      createdAt: caseData.createdAt,
      evaluatedAt: now,
      slaHours: queue.slaHours,
    })
  }

  const action =
    targetStage.category === 'closed' ? 'closed_successful' : 'stage_advanced'
  const [updated] = await db.transaction(async (tx) => {
    if (targetStage.category === 'closed') {
      await assertCloseBlockersSatisfied(tx, {
        merchantId: caseData.merchantId,
        queueId: caseData.queueId,
      })
    }

    const updatedRows = await tx
      .update(cases)
      .set(updateData)
      .where(
        and(
          eq(cases.id, caseId),
          eq(cases.ownerId, userId),
          eq(cases.currentStageId, caseData.currentStageId),
          eq(cases.status, caseData.status),
        ),
      )
      .returning()

    if (!updatedRows[0]) {
      throw new AppError(409, 'Case stage was already updated.')
    }

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action,
      details: {
        fromStage: currentStage.name,
        toStage: targetStage.name,
      },
    })

    if (targetStage.category === 'closed') {
      await triggerCasesAfterSuccessfulClose(tx, {
        id: caseId,
        merchantId: caseData.merchantId,
        queueId: caseData.queueId,
      })

      if (queue?.slug === TESTING_QUEUE_SLUG) {
        await tx
          .update(merchants)
          .set({
            status: 'testing',
            updatedAt: now,
          })
          .where(eq(merchants.id, caseData.merchantId))
      }

      if (queue?.slug === LIVE_QUEUE_SLUG) {
        await tx
          .update(merchants)
          .set({
            status: 'live',
            liveAt: now,
            updatedAt: now,
          })
          .where(eq(merchants.id, caseData.merchantId))
      }
    }

    return updatedRows
  })

  return updated
}

// ─── Save Field Reviews ─────────────────────────────────────────────────────

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
      status: cases.status,
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
      'Rejection changes are locked while awaiting client resubmission.',
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

  const currentStage = await db.query.queueStages.findFirst({
    where: eq(queueStages.id, caseData.currentStageId),
  })

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Field reviews can only be saved in an in-progress stage.',
    )
  }

  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, caseData.queueId),
    columns: { slug: true },
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

    if (queue?.slug !== 'documents-review') {
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
      caseNumber: cases.caseNumber,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.queueSlug !== 'documents-review') {
    throw new AppError(
      400,
      'Sub-merchant selection is only available for document review cases.',
    )
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can select the sub-merchant.')
  }

  if (caseRow.status !== 'working' || !caseRow.currentStageId) {
    throw new AppError(
      400,
      'Sub-merchant can only be selected while the case is working.',
    )
  }

  const subMerchant = await db.query.subMerchantDraftTemplates.findFirst({
    where: eq(subMerchantDraftTemplates.id, input.subMerchantId),
    columns: { id: true, name: true },
  })

  if (!subMerchant) {
    throw new AppError(400, 'Invalid sub-merchant selection.')
  }

  const now = new Date()
  const [details] = await db.transaction(async (tx) => {
    const [upserted] = await tx
      .insert(documentReviewDetails)
      .values({
        caseId,
        subMerchantId: subMerchant.id,
        subMerchantName: subMerchant.name,
        selectedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: documentReviewDetails.caseId,
        set: {
          subMerchantId: subMerchant.id,
          subMerchantName: subMerchant.name,
          selectedBy: userId,
          updatedAt: now,
        },
      })
      .returning()

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'document_review_sub_merchant_selected',
      details: {
        subMerchantId: subMerchant.id,
        subMerchantName: subMerchant.name,
        caseNumber: caseRow.caseNumber,
      },
      createdAt: now,
    })

    return [upserted]
  })

  if (!details) {
    throw new AppError(500, 'Failed to save sub-merchant selection.')
  }

  return {
    subMerchantId: details.subMerchantId,
    subMerchantName: details.subMerchantName,
    selectedAt: details.updatedAt.toISOString(),
  }
}

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
    columns: { slug: true },
  })

  // Verify not already closed
  if (caseData.currentStageId) {
    const currentStage = await db.query.queueStages.findFirst({
      where: eq(queueStages.id, caseData.currentStageId),
    })
    if (
      currentStage?.category === 'closed' ||
      currentStage?.category === 'error'
    ) {
      throw new AppError(400, 'Case is already in a terminal stage.')
    }
  }

  const closedStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseData.queueId),
      eq(queueStages.category, 'closed'),
    ),
  })

  if (!closedStage) {
    throw new AppError(500, 'No closed stage configured for this queue.')
  }

  const now = new Date()
  const [updated] = await db.transaction(async (tx) => {
    const updatedRows = await tx
      .update(cases)
      .set({
        currentStageId: closedStage.id,
        status:
          queue?.slug === 'documents-review' ||
          queue?.slug === AGREEMENT_QUEUE_SLUG
            ? 'closed'
            : 'error',
        closeOutcome: 'unsuccessful',
        slaBreached: isCaseSlaBreached({
          createdAt: caseData.createdAt,
          evaluatedAt: now,
          slaHours: queue?.slaHours,
        }),
        closeReason: input.reason,
        closedAt: now,
        updatedAt: now,
      })
      .where(eq(cases.id, caseId))
      .returning()

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'closed_unsuccessful',
      details: { reason: input.reason },
    })

    return updatedRows
  })

  return updated
}

// ─── Case Comments ──────────────────────────────────────────────────────────

export async function markTestingLimitsApplied(
  caseId: string,
  userId: string,
  input: MarkTestingLimitsAppliedInput,
) {
  const db = getDb()
  void input

  const [caseRow] = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      status: cases.status,
      currentStageId: cases.currentStageId,
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.queueSlug !== TESTING_QUEUE_SLUG) {
    throw new AppError(400, 'This action is only available for Testing cases.')
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await db.query.queueStages.findFirst({
        where: eq(queueStages.id, caseRow.currentStageId),
      })
    : null

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Testing limits can only be confirmed in an in-progress stage.',
    )
  }

  const existingEntry = await getTestingLimitsAppliedEntry(caseId)
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
    action: 'testing_limits_applied',
    details: {
      collection: '10-100',
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
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.queueSlug !== LIVE_QUEUE_SLUG) {
    throw new AppError(400, 'This action is only available for Live cases.')
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await db.query.queueStages.findFirst({
        where: eq(queueStages.id, caseRow.currentStageId),
      })
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
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.queueSlug !== MID_CREATION_QUEUE_SLUG) {
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
    ? await db.query.queueStages.findFirst({
        where: eq(queueStages.id, caseRow.currentStageId),
      })
    : null

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(400, 'MID details can only be saved in working.')
  }

  const savedAt = new Date()
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'mid_creation_saved',
    details: {
      portalMid: input.portalMid,
      portalMuid: input.portalMuid,
      email: input.email,
      password: input.password,
      paymentMethods: input.paymentMethods,
      payoutMethods: input.payoutMethods,
    },
    createdAt: savedAt,
  })

  return {
    portalMid: input.portalMid,
    portalMuid: input.portalMuid,
    email: input.email,
    paymentMethods: input.paymentMethods,
    payoutMethods: input.payoutMethods,
    savedAt: savedAt.toISOString(),
  }
}

async function loadWordpressWebsiteCase(caseId: string, userId: string) {
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
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Case not found.')
  }

  if (row.queueSlug !== WORDPRESS_WEBSITE_QUEUE_SLUG) {
    throw new AppError(
      400,
      'This action is only available for WordPress Website cases.',
    )
  }

  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }

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
    subMerchantLogoScreenshots: File[]
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

  if (input.screenshots.length > 30) {
    throw new AppError(400, 'Upload no more than 30 page screenshots.')
  }

  if (input.subMerchantLogoScreenshots.length > 30) {
    throw new AppError(
      400,
      'Upload no more than 30 sub-merchant logo screenshots.',
    )
  }

  for (const screenshot of input.screenshots) {
    validateWordpressScreenshotFile(screenshot)
  }
  for (const screenshot of input.subMerchantLogoScreenshots) {
    validateWordpressScreenshotFile(screenshot)
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

  const storage = new GoogleDriveStorageProvider()
  const folder = await storage.createMerchantFolder(
    buildCaseUploadFolderName(caseRow.caseNumber, caseRow.merchantName),
  )

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
    input.subMerchantLogoScreenshots.map((file, index) =>
      storage
        .uploadFile(folder.folderId, {
          fileName: `sub-merchant-logo-${String(index + 1).padStart(2, '0')}-${file.name}`,
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

    for (const { file, uploaded, index } of uploadedLogoScreenshots) {
      const [savedFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: `${WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX}${String(index + 1).padStart(2, '0')}`,
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

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'wordpress_website_saved',
      details: {
        businessWebsite: caseRow.businessWebsite,
        clonedWebsiteLink: input.clonedWebsiteLink,
        screenshots: savedFiles.length,
        subMerchantLogoScreenshots: savedLogoFiles.length,
      },
      createdAt: now,
    })

    return {
      clonedWebsiteLink: input.clonedWebsiteLink,
      savedAt: now.toISOString(),
      screenshots: savedFiles,
      subMerchantLogoScreenshots: savedLogoFiles,
    }
  })

  const replacedFileIds = new Set(
    [...uploadedScreenshots, ...uploadedLogoScreenshots].map(
      ({ uploaded }) => uploaded.fileId,
    ),
  )
  for (const oldFile of [...existingFiles, ...existingLogoFiles]) {
    if (!replacedFileIds.has(oldFile.googleDriveFileId)) {
      await storage.deleteFile(oldFile.googleDriveFileId).catch((error) => {
        console.error('[wordpress-website.cleanup]', error)
      })
    }
  }

  return saved
}

export async function listCaseComments(caseId: string) {
  const db = getDb()

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const comments = await db
    .select({
      id: caseComments.id,
      caseId: caseComments.caseId,
      authorId: caseComments.authorId,
      authorName: users.name,
      authorUsername: users.username,
      content: caseComments.content,
      parentId: caseComments.parentId,
      mentions: caseComments.mentions,
      createdAt: caseComments.createdAt,
      updatedAt: caseComments.updatedAt,
    })
    .from(caseComments)
    .leftJoin(users, eq(caseComments.authorId, users.id))
    .where(eq(caseComments.caseId, caseId))
    .orderBy(asc(caseComments.createdAt))

  return comments
}

export async function createCaseComment(
  caseId: string,
  userId: string,
  input: CreateCommentInput,
) {
  const db = getDb()

  // Verify parent comment exists if provided
  if (input.parentId) {
    const parent = await db.query.caseComments.findFirst({
      where: and(
        eq(caseComments.id, input.parentId),
        eq(caseComments.caseId, caseId),
      ),
      columns: { id: true },
    })
    if (!parent) {
      throw new AppError(404, 'Parent comment not found.')
    }
  }

  const [created] = await db
    .insert(caseComments)
    .values({
      caseId,
      authorId: userId,
      content: input.content,
      parentId: input.parentId ?? null,
      mentions: input.mentions ?? null,
    })
    .returning()

  // Notifications (best-effort)
  if (created) {
    try {
      await notifyOnComment({
        caseId,
        commentId: created.id,
        parentCommentId: input.parentId ?? null,
        authorId: userId,
        mentions: input.mentions ?? [],
        content: input.content,
      })
    } catch (error) {
      console.error('[notifications] createCaseComment notify failed', error)
    }
  }

  return created
}

// ─── Case History ───────────────────────────────────────────────────────────

export async function listCaseHistory(caseId: string) {
  const db = getDb()

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true, merchantId: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const history = await db
    .select({
      id: caseHistory.id,
      caseId: caseHistory.caseId,
      actorId: caseHistory.actorId,
      actorName: users.name,
      action: caseHistory.action,
      details: caseHistory.details,
      createdAt: caseHistory.createdAt,
    })
    .from(caseHistory)
    .leftJoin(users, eq(caseHistory.actorId, users.id))
    .where(
      and(
        eq(caseHistory.caseId, caseId),
        sql`${caseHistory.action} <> 'comment_added'`,
      ),
    )
    .orderBy(
      desc(caseHistory.createdAt),
      sql`case
        when ${caseHistory.action} = 'resubmission_email_sent' then 2
        when ${caseHistory.action} = 'rejections_prepared' then 1
        else 0
      end desc`,
      desc(caseHistory.id),
    )

  const merchantContact = await db.query.merchants.findFirst({
    where: eq(merchants.id, existing.merchantId),
    columns: { activeWhatsappNumber: true },
  })
  const activeWhatsappNumber = merchantContact?.activeWhatsappNumber ?? null

  const sanitizedHistory = history.map((entry) => ({
    ...entry,
    details: enrichResubmissionWhatsappHistoryDetails(
      entry.action,
      sanitizeCaseHistoryDetails(entry.action, entry.details),
      activeWhatsappNumber,
    ),
  }))
  const screenshotFileIds = sanitizedHistory
    .map((entry) => getStringDetail(entry.details, 'screenshotFileId'))
    .filter((id): id is string => Boolean(id))

  if (screenshotFileIds.length === 0) return sanitizedHistory

  const proofFiles = await db
    .select({
      id: caseFiles.id,
      originalName: caseFiles.originalName,
      mimeType: caseFiles.mimeType,
      sizeBytes: caseFiles.sizeBytes,
      googleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
      googleDriveDownloadLink: caseFiles.googleDriveDownloadLink,
      createdAt: caseFiles.createdAt,
    })
    .from(caseFiles)
    .where(inArray(caseFiles.id, screenshotFileIds))
  const proofFileById = new Map(proofFiles.map((file) => [file.id, file]))

  return sanitizedHistory.map((entry) => {
    const screenshotFileId = getStringDetail(entry.details, 'screenshotFileId')
    const proofFile = screenshotFileId
      ? proofFileById.get(screenshotFileId)
      : null

    if (!proofFile) return entry

    return {
      ...entry,
      details: {
        ...(entry.details as Record<string, unknown>),
        proofFile: {
          ...proofFile,
          createdAt: proofFile.createdAt.toISOString(),
        },
      },
    }
  })
}

function sanitizeCaseHistoryDetails(action: string, details: unknown) {
  if (
    action !== 'mid_creation_saved' ||
    !details ||
    typeof details !== 'object'
  ) {
    return details
  }

  const { password: _password, ...safeDetails } = details as Record<
    string,
    unknown
  >
  return safeDetails
}

function enrichResubmissionWhatsappHistoryDetails(
  action: string,
  details: unknown,
  activeWhatsappNumber: string | null,
) {
  if (
    action !== 'resubmission_whatsapp_sent_manual' ||
    !activeWhatsappNumber ||
    !details ||
    typeof details !== 'object'
  ) {
    return details
  }

  const safeDetails = details as Record<string, unknown>
  if (
    typeof safeDetails.whatsappRecipient === 'string' &&
    safeDetails.whatsappRecipient.trim()
  ) {
    return details
  }

  return {
    ...safeDetails,
    recipient: activeWhatsappNumber,
    whatsappRecipient: activeWhatsappNumber,
  }
}

function getStringDetail(details: unknown, key: string) {
  if (!details || typeof details !== 'object') return null
  const value = (details as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}

// ─── Send For Resubmission ──────────────────────────────────────────────────

type SendForResubmissionResult = {
  status: 'sent' | 'failed'
  tokenExpiresAt: string | null
  emailLogId: string
  error?: string
}

function getRejectionLabel(
  fieldName: string,
  documentTypeById: Map<string, string>,
): string {
  if (isDocumentFieldName(fieldName)) {
    const docId = getDocumentIdFromFieldName(fieldName)
    const docType = docId ? documentTypeById.get(docId) : null
    if (docType && docType in DOCUMENT_TYPE_LABELS) {
      return DOCUMENT_TYPE_LABELS[docType as keyof typeof DOCUMENT_TYPE_LABELS]
    }
    return 'Uploaded document'
  }
  return MERCHANT_FIELD_LABELS[fieldName] ?? fieldName
}

function formatExpiryDate(date: Date): string {
  if (date.getFullYear() >= 9999) return 'no expiry'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(date)
}

function formatEmailDateTime(date: Date): string {
  return new Intl.DateTimeFormat('en-PK', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Karachi',
    timeZoneName: 'short',
  }).format(date)
}

// ─── Email mode guards ────────────────────────────────────────────────────────

async function assertAutoEmailEnabled(): Promise<void> {
  const mode = await getEmailSendingModeSettings()
  if (!mode.autoEnabled) {
    throw new AppError(
      403,
      'Automatic email sending is disabled. Use the manual email workflow.',
    )
  }
}

async function assertManualEmailEnabled(): Promise<void> {
  const mode = await getEmailSendingModeSettings()
  if (!mode.manualEnabled) {
    throw new AppError(
      403,
      'Manual email sending is disabled. Use the automatic email workflow.',
    )
  }
}

// ─── Email proof upload helper ────────────────────────────────────────────────

function validateEmailProofFile(file: File) {
  if (file.size > 10 * 1024 * 1024) {
    throw new AppError(400, 'Screenshot must be 10 MB or smaller.')
  }
  const mimeType = file.type || 'application/octet-stream'
  if (!EMAIL_PROOF_MIME_TYPES.has(mimeType)) {
    throw new AppError(400, 'Screenshot must be a JPEG, PNG, or WebP image.')
  }
}

async function uploadEmailProofFile(
  caseId: string,
  userId: string,
  file: File,
  fileKind: string,
  caseNumber: string,
  merchantName: string,
) {
  const db = getDb()
  const storage = new GoogleDriveStorageProvider()
  const folder = await storage.createMerchantFolder(
    buildCaseUploadFolderName(caseNumber, merchantName),
  )
  const uploaded = await storage.uploadFile(folder.folderId, {
    fileName: file.name,
    mimeType: file.type,
    file,
  })

  const now = new Date()
  const [savedFile] = await db
    .insert(caseFiles)
    .values({
      caseId,
      fileKind,
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
    throw new AppError(500, 'Failed to save email proof screenshot.')
  }

  return { savedFile, uploaded }
}

// ─── Resubmission email preview & manual confirm ──────────────────────────────

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
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantWhatsappNumber: merchants.activeWhatsappNumber,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.queueSlug !== 'documents-review') {
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
  if (!row.merchantSubmitterEmail) {
    throw new AppError(400, 'No submitter email is on file for this merchant.')
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

  const issued = existingToken
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
    recipient: row.merchantSubmitterEmail,
    subject,
    body,
    tokenId: issued.tokenId,
    tokenExpiresAt: issued.expiresAt.toISOString(),
  }
}

function buildResubmissionEmailBody(params: {
  merchantName: string
  ownerName: string
  rejections: Array<{ label: string; remarks: string | null }>
  resubmissionUrl: string
  expiresAt: string
}): string {
  const { merchantName, ownerName, rejections, resubmissionUrl, expiresAt } =
    params
  const itemLines = rejections
    .map((r) => `• ${r.label}${r.remarks ? `\n  ${r.remarks}` : ''}`)
    .join('\n')
  return `Hi ${ownerName},

We've reviewed the onboarding submission for ${merchantName} and need a few items updated before we can move forward.

Items to update:
${itemLines}

Please use the secure link below to update your submission:
${resubmissionUrl}

This link expires ${expiresAt}.

If you have any questions, please reply to this email.

Best regards,
AssanPay Onboarding Team`
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
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'

  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      queueId: cases.queueId,
      currentStageId: cases.currentStageId,
      queueSlug: queues.slug,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
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
  if (!row.merchantSubmitterEmail)
    throw new AppError(400, 'No submitter email on file.')
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

  const stages = await ensureQueueStages(db, {
    id: row.queueId,
    name: 'Documents Review',
    slug: row.queueSlug,
    qcEnabled: false,
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
    row.merchantName,
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
        recipient:
          channel === 'whatsapp'
            ? row.merchantWhatsappNumber
            : row.merchantSubmitterEmail,
        emailRecipient: row.merchantSubmitterEmail,
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
  input: { remarks?: string | null } = {},
): Promise<AgreementEmailPreviewResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId, {
    allowAwaitingClient: true,
  })

  if (!caseRow.merchantSubmitterEmail) {
    throw new AppError(400, 'No submitter email is on file for this merchant.')
  }

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

  const issued = existingToken
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
    recipient: caseRow.merchantSubmitterEmail,
    subject,
    body,
    tokenId: issued.tokenId,
    tokenExpiresAt: issued.expiresAt.toISOString(),
  }
}

function buildAgreementEmailBody(params: {
  merchantName: string
  ownerName: string
  agreementUrl: string
  expiresAt: string
  remarks: string | null
}): string {
  const { merchantName, ownerName, agreementUrl, expiresAt, remarks } = params
  let body = `Hi ${ownerName},

Please review and sign the agreement for ${merchantName} using the secure link below:`

  if (remarks) {
    body += `\n\nAdditional notes from our team:\n${remarks}`
  }

  body += `\n\nAgreement link:\n${agreementUrl}\n\nThis link expires ${expiresAt}.

If you have any questions, please reply to this email.

Best regards,
AssanPay Onboarding Team`

  return body
}

export async function confirmAgreementEmailManual(
  caseId: string,
  userId: string,
  input: {
    tokenId: string
    remarks?: string | null
    file: File
    channel?: ManualCommunicationChannel
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'

  const caseRow = await loadAgreementCase(caseId, userId, {
    allowAwaitingClient: channel === 'whatsapp',
  })
  if (!caseRow.merchantSubmitterEmail) {
    throw new AppError(400, 'No submitter email is on file for this merchant.')
  }

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
    caseRow.merchantName,
  )

  const remarks = input.remarks?.trim() || null
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(agreementCaseDetails)
      .set({
        emailStatus: 'sent',
        emailSentAt: now,
        emailRecipient: caseRow.merchantSubmitterEmail,
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
        recipient: caseRow.merchantSubmitterEmail,
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
  const existingToken = await db.query.midGoLiveTokens.findFirst({
    where: and(
      eq(midGoLiveTokens.caseId, caseId),
      isNull(midGoLiveTokens.consumedAt),
      gt(midGoLiveTokens.availableAt, minExpiry),
    ),
    orderBy: [desc(midGoLiveTokens.createdAt)],
  })

  let tokenId: string
  let goLiveToken: string
  let resolvedAvailableAt: Date

  if (existingToken) {
    tokenId = existingToken.id
    goLiveToken = existingToken.token
    resolvedAvailableAt = existingToken.availableAt
  } else {
    const token = generatePublicTokenString()
    resolvedAvailableAt = availableAt
    const [tokenRow] = await db
      .insert(midGoLiveTokens)
      .values({ caseId, token, availableAt, createdBy: userId })
      .returning({ id: midGoLiveTokens.id })
    if (!tokenRow) throw new AppError(500, 'Failed to issue Go-Live token.')
    tokenId = tokenRow.id
    goLiveToken = token
  }

  const goLiveUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/go-live/${goLiveToken}`
  const isShopify = caseRow.websiteCms === 'shopify'
  const subject = `AssanPay merchant portal credentials for ${caseRow.merchantName}`
  const body = buildMidCreationMessageBody({
    merchantName: caseRow.merchantName,
    portalEmail: credentials.email,
    portalPassword: credentials.password,
    portalMid: String(credentials.portalMid),
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
  })

  return {
    recipient: credentials.email,
    subject,
    body,
    tokenId,
    goLiveAvailableAt: resolvedAvailableAt.toISOString(),
  }
}

function buildMidCreationEmailBody(params: {
  merchantName: string
  portalEmail: string
  portalPassword: string
  portalMid: string
  merchantPortalUrl: string
  goLiveUrl: string
  availableAt: string
  goLiveAvailabilityHours: number | null
  testingLimits: {
    transactionLimit: number
    dailyLimit: number
    monthlyLimit: number
  }
  cardRate: string
  eWalletsRate: string
  payoutRate: string
}): string {
  const {
    merchantName,
    portalEmail,
    portalPassword,
    portalMid,
    merchantPortalUrl,
    goLiveUrl,
    availableAt,
    goLiveAvailabilityHours,
    testingLimits,
    cardRate,
    eWalletsRate,
    payoutRate,
  } = params
  const goLiveAvailabilityLabel =
    goLiveAvailabilityHours == null
      ? 'immediately'
      : `after ${goLiveAvailabilityHours}h`
  return `AssanPay Merchant Portal Credentials for ${merchantName}

Portal Login: ${merchantPortalUrl}
Email: ${portalEmail}
Password: ${portalPassword}
MID: ${portalMid}

Testing Limits:
• Per Transaction: PKR ${testingLimits.transactionLimit.toLocaleString()}
• Daily: PKR ${testingLimits.dailyLimit.toLocaleString()}
• Monthly: PKR ${testingLimits.monthlyLimit.toLocaleString()}

Rates:
• Card: ${cardRate}
• eWallets: ${eWalletsRate}
• Payout: ${payoutRate}

Go-Live Link (available ${goLiveAvailabilityLabel}):
${goLiveUrl}
Available at: ${availableAt}

Before Go-Live can proceed, send the signed physical agreement to AssanPay Head Office. This physical agreement copy is required for live activation.

Please keep your credentials secure and do not share them with anyone.

Best regards,
AssanPay Onboarding Team`
}

function buildMidCreationMessageBody(params: {
  merchantName: string
  portalEmail: string
  portalPassword: string
  portalMid: string
  merchantPortalUrl: string
  goLiveUrl: string
  availableAt: string
  goLiveAvailabilityHours: number | null
  testingLimits: {
    collectionMin: number
    collectionMax: number
    disbursementMin: number
    disbursementMax: number
  }
  cardRate: string
  eWalletsRate: string
  payoutRate: string
}): string {
  const goLiveAvailabilityLabel =
    params.goLiveAvailabilityHours == null
      ? 'immediately'
      : `after ${params.goLiveAvailabilityHours}h`

  return `AssanPay Merchant Portal Credentials for ${params.merchantName}

Portal Login: ${params.merchantPortalUrl}
Email: ${params.portalEmail}
Password: ${params.portalPassword}
MID: ${params.portalMid}

Testing Limits:
- Collection: PKR ${params.testingLimits.collectionMin.toLocaleString()}-${params.testingLimits.collectionMax.toLocaleString()}
- Disbursement: PKR ${params.testingLimits.disbursementMin.toLocaleString()}-${params.testingLimits.disbursementMax.toLocaleString()}

Rates:
- Card: ${params.cardRate}
- eWallets: ${params.eWalletsRate}
- Payout: ${params.payoutRate}

Go-Live Link (available ${goLiveAvailabilityLabel}):
${params.goLiveUrl}
Available at: ${params.availableAt}

Before Go-Live can proceed, send the signed physical agreement to AssanPay Head Office. This physical agreement copy is required for live activation.

Please keep your credentials secure and do not share them with anyone.

Best regards,
AssanPay Onboarding Team`
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
  validateEmailProofFile(input.file)
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
    caseRow.merchantName,
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
      recipient: credentials.email,
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
  const subject = `AssanPay account is live for ${caseRow.merchantName}`

  return {
    recipient: input.email,
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
  validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'
  const caseRow = await loadLiveCase(caseId, userId)

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
    caseRow.merchantName,
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
        recipient: input.email,
        screenshotFileId: savedFile.id,
        channel,
        manual: true,
      },
      createdAt: new Date(),
    })

  return { status: 'sent', fileId: savedFile.id }
}

function buildLiveActivationEmailBody(params: {
  merchantName: string
  merchantPortalUrl: string
  liveLimits: {
    collectionMin: number
    collectionMax: number
    disbursementMin: number
    disbursementMax: number
  }
}) {
  const { merchantName, merchantPortalUrl, liveLimits } = params
  return `AssanPay account is live for ${merchantName}

Congratulations, ${merchantName}. Your AssanPay merchant account is live now and ready for production transactions.

Merchant Portal Link: ${merchantPortalUrl}

Live Limits Per Transaction
- Collection: PKR ${liveLimits.collectionMin.toLocaleString()}-${liveLimits.collectionMax.toLocaleString()}
- Disbursement: PKR ${liveLimits.disbursementMin.toLocaleString()}-${liveLimits.disbursementMax.toLocaleString()}

You can use the merchant portal to monitor live activity and manage your AssanPay merchant account.

If you need any help, just reply to this email.

- AssanPay Onboarding Team`
}

export async function sendForResubmission(
  caseId: string,
  userId: string,
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
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Case not found.')
  }

  if (row.queueSlug !== 'documents-review') {
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

  if (!row.merchantSubmitterEmail) {
    throw new AppError(400, 'No submitter email is on file for this merchant.')
  }

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

  // 4. Ensure queue stages are fully seeded, then resolve awaiting_client
  const stages = await ensureQueueStages(db, {
    id: row.queueId,
    name:
      row.queueSlug === 'documents-review' ? 'Documents Review' : row.queueSlug,
    slug: row.queueSlug,
    qcEnabled: false,
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
  const minExpiry = new Date(Date.now() + 60 * 60 * 1000)
  const existingToken = await db.query.caseResubmissionTokens.findFirst({
    where: and(
      eq(caseResubmissionTokens.caseId, caseId),
      isNull(caseResubmissionTokens.consumedAt),
      gt(caseResubmissionTokens.expiresAt, minExpiry),
    ),
    orderBy: [desc(caseResubmissionTokens.createdAt)],
  })
  const issued = existingToken
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

  const preparedAt = new Date()

  // 6. Send the email
  const resubmissionUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/resubmit/${issued.token}`
  const emailResult = await sendEmail({
    to: row.merchantSubmitterEmail,
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
        emailLogId: emailResult.emailLogId,
        recipient: row.merchantSubmitterEmail,
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

// ─── EP Sub-Merchant Form ───────────────────────────────────────────────────

async function loadSubMerchantFormCase(caseId: string, userId: string) {
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
      queueSlug: queues.slug,
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

  if (row.queueSlug !== SUB_MERCHANT_FORM_QUEUE_SLUG) {
    throw new AppError(
      400,
      'This action is only available for EP Sub-Merchant Form cases.',
    )
  }

  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }

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
  validateSubMerchantFinalFormFile(file)

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

  const storage = new GoogleDriveStorageProvider()
  const folder = await storage.createMerchantFolder(
    buildCaseUploadFolderName(caseRow.caseNumber, caseRow.merchantName),
  )
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
    await storage.deleteFile(existingFile.googleDriveFileId).catch((error) => {
      console.error('[sub-merchant-form.cleanup]', error)
    })
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
  validateWordpressScreenshotFile(file)

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

  const storage = new GoogleDriveStorageProvider()
  const folder = await storage.createMerchantFolder(
    buildCaseUploadFolderName(caseRow.caseNumber, caseRow.merchantName),
  )
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
    await storage.deleteFile(existingFile.googleDriveFileId).catch((error) => {
      console.error('[sub-merchant-form.email-proof.cleanup]', error)
    })
  }

  return savedFile
}

// ─── Apply Resubmission (called from public route) ──────────────────────────

type MidCreationEmailResult = {
  status: 'sent' | 'failed'
  emailLogId: string
  goLiveAvailableAt: string | null
  error?: string
}

async function loadMidCreationCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      websiteCms: merchants.websiteCms,
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.queueSlug !== TESTING_QUEUE_SLUG) {
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

async function loadLiveCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.queueSlug !== LIVE_QUEUE_SLUG) {
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

export async function sendMidCreationCredentialsEmail(
  caseId: string,
  userId: string,
  _input: SendMidCreationEmailInput,
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

  const [tokenRow] = await db
    .insert(midGoLiveTokens)
    .values({
      caseId,
      token,
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

  const emailResult = await sendEmail({
    to: credentials.email,
    subject: `AssanPay merchant portal credentials for ${caseRow.merchantName}`,
    template: 'mid-creation',
    react: MidCreationEmail({
      merchantName: caseRow.merchantName,
      portalEmail: credentials.email,
      portalPassword: credentials.password,
      portalMid: credentials.portalMid,
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
      },
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `mid-creation/${caseId}/${tokenRow.id}`,
    metadata: {
      tokenId: tokenRow.id,
      availableAt: availableAt.toISOString(),
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
      recipient: credentials.email,
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

export async function sendLiveActivationEmail(
  caseId: string,
  userId: string,
  input: SendLiveEmailInput,
): Promise<MidCreationEmailResult> {
  await assertAutoEmailEnabled()
  const db = getDb()
  const caseRow = await loadLiveCase(caseId, userId)
  const [limitsAndMdr, merchantPortal] = await Promise.all([
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])

  const emailResult = await sendEmail({
    to: input.email,
    subject: `AssanPay account is live for ${caseRow.merchantName}`,
    template: 'live-activation',
    react: LiveActivationEmail({
      merchantName: caseRow.merchantName,
      merchantPortalUrl: merchantPortal.loginUrl,
      liveLimits: limitsAndMdr.live,
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `live-activation/${caseId}`,
    metadata: {
      recipient: input.email,
      merchantPortalUrl: merchantPortal.loginUrl,
      liveLimits: limitsAndMdr.live,
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
      recipient: input.email,
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
    goLiveAvailableAt: null,
  }
}

type AgreementEmailResult = {
  status: 'sent' | 'failed'
  emailLogId: string
  tokenExpiresAt: string | null
  error?: string
}

function validateAgreementFile(file: File) {
  if (file.size > MAX_SUB_MERCHANT_FINAL_FORM_BYTES) {
    throw new AppError(400, 'Agreement must be 1 MB or smaller.')
  }

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !AGREEMENT_FILE_EXTENSIONS.has(extension) ||
    !AGREEMENT_FILE_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(400, 'Agreement must be a PDF, DOC, or DOCX file.')
  }
}

function validatePhysicalAgreementFile(file: File) {
  if (file.size > MAX_PHYSICAL_AGREEMENT_BYTES) {
    throw new AppError(400, 'Physical agreement copy must be 10 MB or smaller.')
  }

  const extension = getFileExtension(file.name)
  const mimeType = file.type || 'application/octet-stream'
  if (
    !PHYSICAL_AGREEMENT_EXTENSIONS.has(extension) ||
    !PHYSICAL_AGREEMENT_MIME_TYPES.has(mimeType)
  ) {
    throw new AppError(
      400,
      'Physical agreement copy must be a PDF, JPG, PNG, or WebP file.',
    )
  }
}

async function loadPhysicalAgreementCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      merchantName: merchants.businessName,
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.queueSlug !== PHYSICAL_AGREEMENT_QUEUE_SLUG) {
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

async function ensurePhysicalAgreementCaseForMerchant(
  tx: DbTransaction,
  input: { merchantId: string; parentCaseId: string; sourceQueueId: string },
) {
  const queue = await tx.query.queues.findFirst({
    where: eq(queues.slug, PHYSICAL_AGREEMENT_QUEUE_SLUG),
    columns: {
      id: true,
      name: true,
      slug: true,
      qcEnabled: true,
      isActive: true,
    },
  })
  if (!queue) {
    throw new AppError(500, 'Physical Agreement queue is not configured.')
  }
  if (!queue.isActive) {
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

async function loadAgreementCase(
  caseId: string,
  userId: string,
  options: { allowAwaitingClient?: boolean } = {},
) {
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
      merchantType: merchants.merchantType,
      queueId: cases.queueId,
      queueSlug: queues.slug,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.queueSlug !== AGREEMENT_QUEUE_SLUG) {
    throw new AppError(
      400,
      'This action is only available for Agreement cases.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }
  if (
    row.status !== 'working' &&
    !(options.allowAwaitingClient && row.status === 'awaiting_client')
  ) {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

async function ensureAgreementDetails(
  tx: DbTransaction,
  caseId: string,
  merchantType: string,
) {
  const draft = await getConfiguredAgreementDraftForMerchantType(merchantType)
  const now = new Date()
  const [details] = await tx
    .insert(agreementCaseDetails)
    .values({
      caseId,
      businessType: merchantType,
      draftKey: draft.key,
      draftLabel: draft.label,
      draftUrl: draft.draftUrl,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agreementCaseDetails.caseId,
      set: {
        businessType: merchantType,
        draftKey: draft.key,
        draftLabel: draft.label,
        draftUrl: draft.draftUrl,
        updatedAt: now,
      },
    })
    .returning()

  if (!details) {
    throw new AppError(500, 'Failed to prepare Agreement details.')
  }

  return details
}

export async function uploadAgreementFinalAgreement(
  caseId: string,
  userId: string,
  input: { file: File },
) {
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId)
  const file = input.file
  validateAgreementFile(file)

  const existingDetails = await db.query.agreementCaseDetails.findFirst({
    where: eq(agreementCaseDetails.caseId, caseId),
  })
  const existingFile = existingDetails?.finalAgreementFileId
    ? await db.query.caseFiles.findFirst({
        where: eq(caseFiles.id, existingDetails.finalAgreementFileId),
      })
    : null

  const storage = new GoogleDriveStorageProvider()
  const folder = await storage.createMerchantFolder(
    buildCaseUploadFolderName(caseRow.caseNumber, caseRow.merchantName),
  )
  const uploaded = await storage.uploadFile(folder.folderId, {
    fileName: file.name,
    mimeType: file.type,
    file,
  })

  const now = new Date()
  const [savedFile] = await db.transaction(async (tx) => {
    await ensureAgreementDetails(tx, caseId, caseRow.merchantType)

    const [caseFile] = await tx
      .insert(caseFiles)
      .values({
        caseId,
        fileKind: AGREEMENT_FINAL_FILE_KIND,
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
      throw new AppError(500, 'Failed to save Final Agreement.')
    }

    await tx
      .update(agreementCaseDetails)
      .set({
        finalAgreementFileId: caseFile.id,
        emailStatus: 'not_sent',
        emailLogId: null,
        emailSentAt: null,
        emailRecipient: null,
        updatedAt: now,
      })
      .where(eq(agreementCaseDetails.caseId, caseId))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'agreement_final_uploaded',
      details: { fileName: file.name, sizeBytes: uploaded.sizeBytes },
    })

    return [caseFile]
  })

  if (existingFile && existingFile.googleDriveFileId !== uploaded.fileId) {
    await storage.deleteFile(existingFile.googleDriveFileId).catch((error) => {
      console.error('[agreement.cleanup]', error)
    })
  }

  return savedFile
}

export async function uploadPhysicalAgreementCopy(
  caseId: string,
  userId: string,
  input: { file: File },
) {
  const db = getDb()
  const caseRow = await loadPhysicalAgreementCase(caseId, userId)
  const file = input.file
  validatePhysicalAgreementFile(file)

  const existingFile = await db.query.caseFiles.findFirst({
    where: and(
      eq(caseFiles.caseId, caseId),
      eq(caseFiles.fileKind, PHYSICAL_AGREEMENT_FILE_KIND),
    ),
  })

  const storage = new GoogleDriveStorageProvider()
  const folder = await storage.createMerchantFolder(
    buildCaseUploadFolderName(caseRow.caseNumber, caseRow.merchantName),
  )
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
    await storage.deleteFile(existingFile.googleDriveFileId).catch((error) => {
      console.error('[physical-agreement.cleanup]', error)
    })
  }

  return savedFile
}

export async function sendAgreementForClientUpload(
  caseId: string,
  userId: string,
  input: { remarks?: string | null } = {},
): Promise<AgreementEmailResult> {
  await assertAutoEmailEnabled()
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId)

  if (!caseRow.merchantSubmitterEmail) {
    throw new AppError(400, 'No submitter email is on file for this merchant.')
  }

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

  const awaitingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, 'awaiting_client'),
    ),
  })
  if (!awaitingStage) {
    throw new AppError(
      500,
      'No awaiting_client stage configured for this queue.',
    )
  }

  const [reservedCase] = await db
    .update(cases)
    .set({
      status: 'awaiting_client',
      currentStageId: awaitingStage.id,
      updatedAt: new Date(),
    })
    .where(and(eq(cases.id, caseId), eq(cases.status, 'working')))
    .returning({ id: cases.id })
  if (!reservedCase) {
    throw new AppError(409, 'This case has already been sent to the client.')
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
  const issued = existingToken
    ? {
        token: existingToken.token,
        tokenId: existingToken.id,
        expiresAt: existingToken.expiresAt,
      }
    : await issueToken(caseId, userId, linkDeadlines.agreementLinkHours)
  const agreementUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/agreement/${issued.token}`
  const emailResult = await sendEmail({
    to: caseRow.merchantSubmitterEmail,
    subject: `Agreement for ${caseRow.merchantName}`,
    template: 'agreement',
    react: AgreementEmail({
      merchantName: caseRow.merchantName,
      ownerName: caseRow.merchantOwnerName,
      agreementUrl,
      expiresAt: formatExpiryDate(issued.expiresAt),
      remarks,
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `agreement/${caseId}/${issued.tokenId}`,
    metadata: {
      tokenId: issued.tokenId,
      finalAgreementFileId: details.finalAgreementFileId,
      remarks,
    },
  })

  const now = new Date()
  if (emailResult.status === 'failed') {
    await db
      .update(caseResubmissionTokens)
      .set({ consumedAt: now })
      .where(eq(caseResubmissionTokens.id, issued.tokenId))
    await db
      .update(cases)
      .set({
        status: 'working',
        currentStageId: caseRow.currentStageId,
        updatedAt: now,
      })
      .where(eq(cases.id, caseId))
  }

  await db.transaction(async (tx) => {
    await tx
      .update(agreementCaseDetails)
      .set({
        emailStatus: emailResult.status,
        emailLogId: emailResult.emailLogId,
        emailSentAt: emailResult.status === 'sent' ? now : null,
        emailRecipient: caseRow.merchantSubmitterEmail,
        lastRejectionRemarks: remarks,
        updatedAt: now,
      })
      .where(eq(agreementCaseDetails.caseId, caseId))

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action:
        emailResult.status === 'sent'
          ? 'agreement_email_sent'
          : 'agreement_email_failed',
      details: {
        tokenId: issued.tokenId,
        expiresAt:
          emailResult.status === 'sent' ? issued.expiresAt.toISOString() : null,
        emailLogId: emailResult.emailLogId,
        recipient: caseRow.merchantSubmitterEmail,
        remarks,
        error: emailResult.error ?? null,
      },
    })
  })

  if (emailResult.status === 'failed') {
    return {
      status: 'failed',
      emailLogId: emailResult.emailLogId,
      tokenExpiresAt: null,
      error: emailResult.error,
    }
  }

  return {
    status: 'sent',
    emailLogId: emailResult.emailLogId,
    tokenExpiresAt: issued.expiresAt.toISOString(),
  }
}

export type AgreementUploadContext = {
  caseId: string
  caseNumber: string
  expiresAt: string
  merchantName: string
  ownerName: string
  finalAgreementName: string
  finalAgreementUrl: string
  remarks: string | null
}

export async function getAgreementUploadContext(
  caseId: string,
  expiresAt: Date,
): Promise<AgreementUploadContext> {
  const db = getDb()
  const [row] = await db
    .select({
      caseId: cases.id,
      caseNumber: cases.caseNumber,
      merchantName: merchants.businessName,
      ownerName: merchants.ownerFullName,
      finalAgreementName: caseFiles.originalName,
      finalAgreementUrl: caseFiles.googleDriveWebViewLink,
      remarks: agreementCaseDetails.lastRejectionRemarks,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .innerJoin(agreementCaseDetails, eq(agreementCaseDetails.caseId, cases.id))
    .innerJoin(
      caseFiles,
      eq(agreementCaseDetails.finalAgreementFileId, caseFiles.id),
    )
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Agreement upload context not found.')
  }

  return {
    ...row,
    expiresAt: expiresAt.toISOString(),
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
    { documentType: string; originalName: string; currentDocumentUrl?: string }
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

export type MidGoLiveContext = {
  status: 'not_ready' | 'ready' | 'started'
  caseNumber: string
  merchantName: string
  availableAt: string
  liveCaseNumber: string | null
}

export async function getMidGoLiveContext(
  token: string,
): Promise<MidGoLiveContext> {
  const db = getDb()
  const [row] = await db
    .select({
      tokenId: midGoLiveTokens.id,
      availableAt: midGoLiveTokens.availableAt,
      consumedAt: midGoLiveTokens.consumedAt,
      liveCaseId: midGoLiveTokens.liveCaseId,
      midCaseNumber: cases.caseNumber,
      merchantName: merchants.businessName,
    })
    .from(midGoLiveTokens)
    .innerJoin(cases, eq(midGoLiveTokens.caseId, cases.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(midGoLiveTokens.token, token))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Go-Live link not found.')
  }

  const isStarted = Boolean(row.consumedAt && row.liveCaseId)
  const isReady = row.availableAt.getTime() <= Date.now()
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
    liveCaseNumber: liveCase?.caseNumber ?? null,
  }
}

export async function activateMidGoLive(token: string) {
  const db = getDb()

  return db.transaction(async (tx) => {
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
      .where(eq(midGoLiveTokens.token, token))
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
      throw new AppError(425, 'This Go-Live link works after 72 hours only.')
    }

    const liveQueue = await tx.query.queues.findFirst({
      where: eq(queues.slug, LIVE_QUEUE_SLUG),
      columns: {
        id: true,
        name: true,
        slug: true,
        qcEnabled: true,
        isActive: true,
      },
    })
    if (!liveQueue) {
      throw new AppError(500, 'Live queue is not configured.')
    }
    if (!liveQueue.isActive) {
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
