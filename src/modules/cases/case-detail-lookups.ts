import { and, asc, desc, eq, ilike, inArray } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseFieldReviews,
  caseFiles,
  caseHistory,
  cases,
  documentReviewDetails,
  merchants,
  portalMidLimitApplications,
  queues,
  subMerchantDraftTemplates,
  subMerchantFormDetails,
  users,
} from '../../db/schema'
import type { Merchant } from '../../db/schema'
import { AppError } from '../../lib/errors'
import type { SessionUser } from '../../types/auth'
import {
  defaultPaymentMethodSettings,
  defaultPayoutMethodSettings,
  getLimitsAndMdrSettings,
  getMerchantPortalSettings,
  getPaymentMethodSettings,
  getPayoutMethodSettings,
} from '../configuration/configuration.service'
import { paymentMethodSettingsSchema } from '../configuration/configuration.schemas'
import type { PaymentMethodSettings } from '../configuration/configuration.schemas'
import type { QueueWorkflowType } from '../queues/queue-workflow'
import {
  buildInternalMerchantEmail,
  type MerchantPortalRole,
} from './cases.schemas'
import {
  DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS,
  MID_CREATION_CREDENTIALS_SENT_ACTIONS,
  WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX,
  WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX,
  WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX,
} from './case-constants'
import type { DbTransaction } from './case-db'
import { SUB_MERCHANT_EMAIL_PROOF_KIND } from './sub-merchant-form.config'

export async function getTestingLimitsAppliedEntry(caseId: string) {
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

export async function getMidCreationCredentialsSentEntry(caseId: string) {
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
        inArray(caseHistory.action, [...MID_CREATION_CREDENTIALS_SENT_ACTIONS]),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  return entry ?? null
}

export async function getLiveLimitsAppliedEntry(caseId: string) {
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

export async function getDocumentReviewResubmissionSentEntry(caseId: string) {
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

export async function getWordpressWebsiteDetails(caseId: string) {
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
      fileKind: caseFiles.fileKind,
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

  const subMerchantLogoScreenshots = subMerchantLogoScreenshotRows.map(
    ({ fileKind, ...file }) => {
      const subMerchantId = fileKind.slice(
        WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX.length,
      )
      return {
        ...file,
        subMerchantId: /^[0-9a-f-]{36}$/i.test(subMerchantId)
          ? subMerchantId
          : null,
      }
    },
  )

  const assanpayCheckoutScreenshotRows = await db
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
          `${WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX}%`,
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
    subMerchantLogoScreenshots,
    assanpayCheckoutScreenshots: assanpayCheckoutScreenshotRows,
  }
}

export async function getLatestWordpressWebsiteDetailsForMerchant(merchantId: string) {
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
        eq(queues.workflowType, 'wordpress'),
        eq(caseHistory.action, 'wordpress_website_saved'),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  return latestWordpressCase
    ? getWordpressWebsiteDetails(latestWordpressCase.caseId)
    : null
}

export async function getDocumentReviewDetails(caseId: string) {
  const details = await getDb()
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
    .orderBy(asc(documentReviewDetails.subMerchantName))

  const first = details[0]
  if (!first) return null

  return {
    subMerchants: details.map((item) => ({
      id: item.subMerchantId,
      name: item.subMerchantName,
    })),
    selectedAt: first.selectedAt.toISOString(),
    selectedBy: first.selectedById
      ? {
          id: first.selectedById,
          name: first.selectedByName ?? 'Unknown',
        }
      : null,
  }
}

export async function getLatestDocumentReviewDetailsForMerchant(merchantId: string) {
  const [details] = await getDb()
    .select({
      caseId: documentReviewDetails.caseId,
    })
    .from(documentReviewDetails)
    .innerJoin(cases, eq(documentReviewDetails.caseId, cases.id))
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(
      and(
        eq(cases.merchantId, merchantId),
        eq(queues.workflowType, 'document_review'),
      ),
    )
    .orderBy(desc(documentReviewDetails.updatedAt))
    .limit(1)

  if (!details) return null
  return getDocumentReviewDetails(details.caseId)
}

export async function getSubMerchantFormDetails(caseId: string) {
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

export async function ensureInheritedSubMerchantFormDetails(input: {
  caseId: string
  merchantId: string
  actorId?: string | null
}) {
  const db = getDb()
  const existing = await getSubMerchantFormDetails(input.caseId)
  if (existing) return existing

  const caseRow = await db.query.cases.findFirst({
    where: eq(cases.id, input.caseId),
    columns: { subMerchantId: true },
  })
  const documentReviewDetail = caseRow?.subMerchantId
    ? null
    : await getLatestDocumentReviewDetailsForMerchant(input.merchantId)
  const inheritedSubMerchantId =
    caseRow?.subMerchantId ?? documentReviewDetail?.subMerchants[0]?.id
  if (!inheritedSubMerchantId) return null

  const subMerchant = await db.query.subMerchantDraftTemplates.findFirst({
    where: eq(subMerchantDraftTemplates.id, inheritedSubMerchantId),
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

export async function getMidCreationPortalMid(
  merchantId: string,
): Promise<number | null> {
  const credentials = await getMidCreationCredentials(merchantId)
  return credentials?.portalMid ?? null
}

export type MidCreationCredentials = {
  portalMid: number
  internalPortalMid: number
  email: string
  branchCode: string
  internalEmail: string
  internalBranchCode: string
  merchantRole: MerchantPortalRole
  paymentMethods: PaymentMethodSettings
  payoutMethods: PaymentMethodSettings
}

export const DEFAULT_MERCHANT_PORTAL_ROLE: MerchantPortalRole = 'merchant_admin'
export const ROLE_PAYOUT_METHOD_LABELS: Record<MerchantPortalRole, string> = {
  merchant_admin: 'Bank Settlement',
  international_merchant_admin: 'All supported banks/e-wallets',
}

export function buildPortalPassword(email: string) {
  const [localPart = email] = email.trim().split('@')
  return `${localPart.trim().toLowerCase()}@ASSAN123`
}

export async function getMidCreationCredentials(
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
    internalPortalMid?: unknown
    email?: unknown
    branchCode?: unknown
    internalEmail?: unknown
    internalBranchCode?: unknown
    merchantRole?: unknown
    paymentMethods?: unknown
    payoutMethods?: unknown
  } | null
  if (
    typeof details?.portalMid !== 'number' ||
    typeof details.email !== 'string'
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
    internalPortalMid:
      typeof details.internalPortalMid === 'number'
        ? details.internalPortalMid
        : details.portalMid,
    email: details.email,
    branchCode:
      typeof details.branchCode === 'string' ? details.branchCode : '',
    internalEmail: buildInternalMerchantEmail(details.email),
    internalBranchCode:
      typeof details.internalBranchCode === 'string'
        ? details.internalBranchCode
        : '',
    merchantRole: isMerchantPortalRole(details.merchantRole)
      ? details.merchantRole
      : DEFAULT_MERCHANT_PORTAL_ROLE,
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

export async function getPortalMidLimitApplication(portalMid: number) {
  const [entry] = await getDb()
    .select({
      appliedAt: portalMidLimitApplications.appliedAt,
      appliedBy: portalMidLimitApplications.appliedBy,
      appliedByName: users.name,
    })
    .from(portalMidLimitApplications)
    .leftJoin(users, eq(portalMidLimitApplications.appliedBy, users.id))
    .where(eq(portalMidLimitApplications.portalMid, portalMid))
    .limit(1)

  return entry ?? null
}

export async function getTestingLimitsAppliedEntryForMerchant(merchantId: string) {
  const credentials = await getMidCreationCredentials(merchantId)
  if (!credentials) return null

  const application = await getPortalMidLimitApplication(credentials.portalMid)
  if (!application) return null

  return {
    createdAt: application.appliedAt,
    actorId: application.appliedBy,
    actorName: application.appliedByName,
    portalMid: credentials.portalMid,
  }
}

export async function getInternalPortalMidLimitsAppliedEntryForMerchant(
  merchantId: string,
) {
  const credentials = await getMidCreationCredentials(merchantId)
  if (!credentials) return null

  const application = await getPortalMidLimitApplication(
    credentials.internalPortalMid,
  )
  if (!application) return null

  return {
    createdAt: application.appliedAt,
    actorId: application.appliedBy,
    actorName: application.appliedByName,
    portalMid: credentials.internalPortalMid,
  }
}

export async function assertInternalPortalMidLimitsApplied(merchantId: string) {
  const credentials = await getMidCreationCredentials(merchantId)

  if (!credentials) {
    throw new AppError(
      400,
      'Save Portal MID (Internal) in MID Creation before closing this WordPress Website case.',
    )
  }

  const application = await getPortalMidLimitApplication(
    credentials.internalPortalMid,
  )

  if (!application) {
    throw new AppError(
      400,
      `Live limits have not been applied for Portal MID (Internal) ${credentials.internalPortalMid}. Apply limits from the dashboard before closing this WordPress Website case.`,
    )
  }
}

export async function assertTestingLimitsAppliedForCredentials(
  credentials: MidCreationCredentials,
) {
  const application = await getPortalMidLimitApplication(credentials.portalMid)

  if (!application) {
    throw new AppError(
      400,
      `Limits have not been applied for Portal MID ${credentials.portalMid}. Apply limits from the dashboard before sending credentials.`,
    )
  }
}

export function isMerchantPortalRole(value: unknown): value is MerchantPortalRole {
  return value === 'merchant_admin' || value === 'international_merchant_admin'
}

export function normalizeMethodLabel(value: string) {
  return value.trim().toLowerCase()
}

export function getClientPayoutRateLabel(role: MerchantPortalRole) {
  return role === 'merchant_admin' ? 'Bank Settlement' : 'Payout'
}

export function tokenMatchesGoLiveAvailability(
  token: { availableAt: Date; createdAt: Date },
  goLiveAvailabilityHours: number | null,
) {
  const delayMs = token.availableAt.getTime() - token.createdAt.getTime()
  const toleranceMs = 5 * 60 * 1000

  if (goLiveAvailabilityHours == null) {
    return delayMs <= toleranceMs
  }

  const expectedDelayMs = goLiveAvailabilityHours * 60 * 60 * 1000
  return Math.abs(delayMs - expectedDelayMs) <= toleranceMs
}

export async function getPayoutMethodsForMerchantRole(role: MerchantPortalRole) {
  const expectedLabel = ROLE_PAYOUT_METHOD_LABELS[role]
  const normalizedExpectedLabel = normalizeMethodLabel(expectedLabel)
  const methods = await getPayoutMethodSettings()
  const selectedMethods = methods.filter(
    (method) => normalizeMethodLabel(method.label) === normalizedExpectedLabel,
  )

  if (selectedMethods.length === 0) {
    throw new AppError(
      400,
      `Configure "${expectedLabel}" in payout methods before saving MID details.`,
    )
  }

  return selectedMethods
}

export function parseLegacyMethodSettings(
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

export function getCaseDetailMerchant(input: {
  merchant: Merchant
  workflowType: QueueWorkflowType
  ownerId: string | null
  actor?: SessionUser
}) {
  return input.merchant
}

// ─── Create Case ────────────────────────────────────────────────────────────
