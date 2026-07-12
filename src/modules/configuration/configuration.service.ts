import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  agreementDraftTemplates,
  caseFlowCloseBlockers,
  caseFlowCloseTriggers,
  caseFlowCreationRequirements,
  caseFlowStartRules,
  configurationSettings,
  flowConfigurationRevisions,
  queueStages,
  queues,
  subMerchantDraftTemplates,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import { getAgreementDraftForMerchantType as getFallbackAgreementDraftForMerchantType } from '../cases/agreement.config'
import {
  BUSINESS_TYPE_OPTIONS,
  businessTypeSchema,
  emailSendingModeSettingsSchema,
  limitsAndMdrSettingsSchema,
  linkDeadlineSettingsSchema,
  merchantPortalSettingsSchema,
  paymentMethodSettingsSchema,
  updateCaseFlowConfigurationSchema,
} from './configuration.schemas'
import type {
  BusinessType,
  EmailSendingModeSettings,
  LimitsAndMdrSettings,
  LinkDeadlineSettings,
  MerchantPortalSettings,
  PaymentMethodSettings,
  UpdateCaseFlowConfigurationInput,
} from './configuration.schemas'

const LIMITS_AND_MDR_KEY = 'limits-and-mdr'
const LINK_DEADLINES_KEY = 'link-deadlines'
const EMAIL_SENDING_MODE_KEY = 'email-sending-mode'
const MERCHANT_PORTAL_KEY = 'merchant-portal'
const PAYMENT_METHODS_KEY = 'payment-methods'
const PAYOUT_METHODS_KEY = 'payout-methods'
const MAX_DRAFT_BYTES = 5 * 1024 * 1024
const DRAFT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
const DRAFT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

type QueueRef = {
  id: string
  name: string
  lifecycle: 'draft' | 'active' | 'inactive'
  isActive: boolean
}

type StageReadiness = {
  queueId: string
  hasInitial: boolean
  hasTerminal: boolean
}

export const defaultLimitsAndMdrSettings: LimitsAndMdrSettings = {
  testing: {
    collectionMin: 10,
    collectionMax: 100,
    disbursementMin: 1000,
    disbursementMax: 50000,
  },
  live: {
    collectionMin: 100,
    collectionMax: 50000,
    disbursementMin: 1000,
    disbursementMax: 50000,
  },
  rates: {
    eWallets: 2.5,
    cardDefault: 3,
    cardShopify: 3.5,
    payout: 0,
  },
}

export const defaultLinkDeadlineSettings: LinkDeadlineSettings = {
  passwordResetHours: 72,
  newPasswordSetHours: 72,
  agreementLinkHours: 72,
  documentsReviewResubmissionHours: 72,
  goLiveAvailabilityHours: 72,
}

export const defaultEmailSendingModeSettings: EmailSendingModeSettings = {
  autoEnabled: true,
  manualEnabled: true,
}

export const defaultMerchantPortalSettings: MerchantPortalSettings = {
  loginUrl: 'https://merchant.assanpay.com/login',
  officeAddress: '',
  whatsappSupportNumber: '',
  supportEmail: '',
}

export const defaultPaymentMethodSettings: PaymentMethodSettings = []
export const defaultPayoutMethodSettings: PaymentMethodSettings = []

async function readSetting<T>(
  key: string,
  fallback: T,
  parser: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false }
  },
) {
  const row = await getDb().query.configurationSettings.findFirst({
    where: eq(configurationSettings.key, key),
  })

  if (!row) return fallback

  const parsed = parser.safeParse(row.value)
  return parsed.success ? parsed.data : fallback
}

async function writeSetting(key: string, value: unknown) {
  await getDb()
    .insert(configurationSettings)
    .values({
      key,
      value,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: configurationSettings.key,
      set: {
        value,
        updatedAt: new Date(),
      },
    })
}

async function readPaymentMethodSetting(
  key: string,
  legacyMode: 'collection' | 'disbursement',
) {
  let row = await getDb().query.configurationSettings.findFirst({
    where: eq(configurationSettings.key, key),
  })

  if (!row && key === PAYOUT_METHODS_KEY) {
    row = await getDb().query.configurationSettings.findFirst({
      where: eq(configurationSettings.key, PAYMENT_METHODS_KEY),
    })
  }

  if (!row) {
    return legacyMode === 'collection'
      ? defaultPaymentMethodSettings
      : defaultPayoutMethodSettings
  }

  const parsed = paymentMethodSettingsSchema.safeParse(row.value)
  if (parsed.success) return parsed.data

  const legacyMethods = Array.isArray(row.value) ? row.value : []
  const migrated = legacyMethods.flatMap((method) => {
    if (!method || typeof method !== 'object') return []
    const record = method as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const id =
      typeof record.key === 'string' && record.key.trim()
        ? record.key.trim()
        : label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const enabled =
      legacyMode === 'collection'
        ? record.collectionEnabled !== false
        : record.disbursementEnabled !== false

    return label && id && enabled ? [{ id, label }] : []
  })

  const migratedParsed = paymentMethodSettingsSchema.safeParse(migrated)
  return migratedParsed.success ? migratedParsed.data : []
}

export function getLimitsAndMdrSettings() {
  return readSetting(
    LIMITS_AND_MDR_KEY,
    defaultLimitsAndMdrSettings,
    limitsAndMdrSettingsSchema,
  )
}

export async function updateLimitsAndMdrSettings(input: LimitsAndMdrSettings) {
  const value = limitsAndMdrSettingsSchema.parse(input)
  await writeSetting(LIMITS_AND_MDR_KEY, value)
  return value
}

export function getLinkDeadlineSettings() {
  return readSetting(
    LINK_DEADLINES_KEY,
    defaultLinkDeadlineSettings,
    linkDeadlineSettingsSchema,
  )
}

export async function updateLinkDeadlineSettings(input: LinkDeadlineSettings) {
  const value = linkDeadlineSettingsSchema.parse(input)
  await writeSetting(LINK_DEADLINES_KEY, value)
  return value
}

export function getEmailSendingModeSettings() {
  return readSetting(
    EMAIL_SENDING_MODE_KEY,
    defaultEmailSendingModeSettings,
    emailSendingModeSettingsSchema,
  )
}

export async function updateEmailSendingModeSettings(
  input: EmailSendingModeSettings,
) {
  const value = emailSendingModeSettingsSchema.parse(input)
  await writeSetting(EMAIL_SENDING_MODE_KEY, value)
  return value
}

export function getMerchantPortalSettings() {
  return readSetting(
    MERCHANT_PORTAL_KEY,
    defaultMerchantPortalSettings,
    merchantPortalSettingsSchema,
  )
}

export async function updateMerchantPortalSettings(
  input: MerchantPortalSettings,
) {
  const value = merchantPortalSettingsSchema.parse(input)
  await writeSetting(MERCHANT_PORTAL_KEY, value)
  return value
}

export function getPaymentMethodSettings() {
  return readPaymentMethodSetting(PAYMENT_METHODS_KEY, 'collection')
}

export async function updatePaymentMethodSettings(
  input: PaymentMethodSettings,
) {
  const value = paymentMethodSettingsSchema.parse(input)
  await writeSetting(PAYMENT_METHODS_KEY, value)
  return value
}

export function getPayoutMethodSettings() {
  return readPaymentMethodSetting(PAYOUT_METHODS_KEY, 'disbursement')
}

export async function updatePayoutMethodSettings(input: PaymentMethodSettings) {
  const value = paymentMethodSettingsSchema.parse(input)
  await writeSetting(PAYOUT_METHODS_KEY, value)
  return value
}

export async function getConfigurationOverview() {
  const [
    limitsAndMdr,
    linkDeadlines,
    emailSendingMode,
    merchantPortal,
    paymentMethods,
    payoutMethods,
    agreementDrafts,
    subMerchants,
  ] = await Promise.all([
    getLimitsAndMdrSettings(),
    getLinkDeadlineSettings(),
    getEmailSendingModeSettings(),
    getMerchantPortalSettings(),
    getPaymentMethodSettings(),
    getPayoutMethodSettings(),
    listAgreementDrafts(),
    listSubMerchantDrafts(),
  ])

  return {
    limitsAndMdr,
    linkDeadlines,
    emailSendingMode,
    merchantPortal,
    paymentMethods,
    payoutMethods,
    agreementDrafts,
    subMerchants,
    businessTypes: BUSINESS_TYPE_OPTIONS,
  }
}

export async function listAgreementDrafts() {
  const rows = await getDb().select().from(agreementDraftTemplates)

  const byType = new Map(rows.map((row) => [row.businessType, row]))

  return BUSINESS_TYPE_OPTIONS.map((option) => {
    const row = byType.get(option.value)
    return {
      businessType: option.value,
      label: option.label,
      originalName: row?.originalName ?? null,
      mimeType: row?.mimeType ?? null,
      sizeBytes: row?.sizeBytes ?? null,
      googleDriveWebViewLink: row?.googleDriveWebViewLink ?? null,
      googleDriveDownloadLink: row?.googleDriveDownloadLink ?? null,
      googleDriveFolderId: row?.googleDriveFolderId ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    }
  })
}

export async function uploadAgreementDraft(input: {
  businessType: string
  file: File
}) {
  const businessType = businessTypeSchema.parse(input.businessType)
  const label = getBusinessTypeLabel(businessType)
  const uploaded = await uploadConfigurationDraft({
    folderPath: ['Configuration', 'Agreements', label],
    file: input.file,
  })

  await getDb()
    .insert(agreementDraftTemplates)
    .values({
      businessType,
      label,
      originalName: uploaded.fileName,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      googleDriveFileId: uploaded.fileId,
      googleDriveWebViewLink: uploaded.webViewLink,
      googleDriveDownloadLink: uploaded.downloadLink,
      googleDriveFolderId: uploaded.folderId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: agreementDraftTemplates.businessType,
      set: {
        label,
        originalName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
        googleDriveFileId: uploaded.fileId,
        googleDriveWebViewLink: uploaded.webViewLink,
        googleDriveDownloadLink: uploaded.downloadLink,
        googleDriveFolderId: uploaded.folderId,
        updatedAt: new Date(),
      },
    })

  return listAgreementDrafts()
}

export async function getConfiguredAgreementDraftForMerchantType(
  merchantType: string,
) {
  const label = getBusinessTypeLabel(merchantType as BusinessType)
  const row = await getDb().query.agreementDraftTemplates.findFirst({
    where: eq(agreementDraftTemplates.businessType, merchantType),
  })

  if (row) {
    return {
      key: row.businessType,
      label: row.label,
      draftUrl: row.googleDriveWebViewLink,
    }
  }

  const fallback = getFallbackAgreementDraftForMerchantType(merchantType)
  return {
    key: merchantType,
    label: label === merchantType ? fallback.label : label,
    draftUrl: fallback.draftUrl,
  }
}

export async function listSubMerchantDrafts() {
  const rows = await getDb()
    .select()
    .from(subMerchantDraftTemplates)
    .orderBy(subMerchantDraftTemplates.name)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sellerCode: row.sellerCode,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    googleDriveWebViewLink: row.googleDriveWebViewLink,
    googleDriveDownloadLink: row.googleDriveDownloadLink,
    googleDriveFolderId: row.googleDriveFolderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }))
}

export async function createSubMerchantDraft(input: {
  name: string
  sellerCode: string
  file: File
}) {
  const name = input.name.trim()
  const sellerCode = input.sellerCode.trim()
  if (!name) {
    throw new AppError(400, 'Sub-merchant name is required.')
  }
  if (!sellerCode) {
    throw new AppError(400, 'Seller Code is required.')
  }

  const uploaded = await uploadConfigurationDraft({
    folderPath: ['Configuration', 'Sub-Merchants', name],
    file: input.file,
  })

  await getDb().insert(subMerchantDraftTemplates).values({
    name,
    sellerCode,
    originalName: uploaded.fileName,
    mimeType: uploaded.mimeType,
    sizeBytes: uploaded.sizeBytes,
    googleDriveFileId: uploaded.fileId,
    googleDriveWebViewLink: uploaded.webViewLink,
    googleDriveDownloadLink: uploaded.downloadLink,
    googleDriveFolderId: uploaded.folderId,
    updatedAt: new Date(),
  })

  return listSubMerchantDrafts()
}

export async function getCaseFlowConfiguration() {
  const [
    revisionRow,
    queueRows,
    startRules,
    closeTriggers,
    closeBlockers,
    creationRequirements,
  ] = await Promise.all([
    getDb().query.flowConfigurationRevisions.findFirst({
      where: eq(flowConfigurationRevisions.id, 1),
      columns: { revision: true },
    }),
    getDb()
      .select({
        id: queues.id,
        name: queues.name,
        slug: queues.slug,
        prefix: queues.prefix,
        workflowType: queues.workflowType,
        lifecycle: queues.lifecycle,
        isActive: queues.isActive,
      })
      .from(queues)
      .orderBy(queues.name),
    getDb()
      .select({
        id: caseFlowStartRules.id,
        targetQueueId: caseFlowStartRules.targetQueueId,
        order: caseFlowStartRules.order,
        isActive: caseFlowStartRules.isActive,
      })
      .from(caseFlowStartRules)
      .orderBy(
        asc(caseFlowStartRules.order),
        asc(caseFlowStartRules.createdAt),
      ),
    getDb()
      .select({
        id: caseFlowCloseTriggers.id,
        sourceQueueId: caseFlowCloseTriggers.sourceQueueId,
        targetQueueId: caseFlowCloseTriggers.targetQueueId,
        order: caseFlowCloseTriggers.order,
        isActive: caseFlowCloseTriggers.isActive,
      })
      .from(caseFlowCloseTriggers)
      .orderBy(
        asc(caseFlowCloseTriggers.sourceQueueId),
        asc(caseFlowCloseTriggers.order),
        asc(caseFlowCloseTriggers.createdAt),
      ),
    getDb()
      .select({
        id: caseFlowCloseBlockers.id,
        blockedQueueId: caseFlowCloseBlockers.blockedQueueId,
        prerequisiteQueueId: caseFlowCloseBlockers.prerequisiteQueueId,
        isActive: caseFlowCloseBlockers.isActive,
      })
      .from(caseFlowCloseBlockers)
      .orderBy(
        asc(caseFlowCloseBlockers.blockedQueueId),
        asc(caseFlowCloseBlockers.createdAt),
      ),
    getDb()
      .select({
        id: caseFlowCreationRequirements.id,
        targetQueueId: caseFlowCreationRequirements.targetQueueId,
        prerequisiteQueueId: caseFlowCreationRequirements.prerequisiteQueueId,
        isActive: caseFlowCreationRequirements.isActive,
      })
      .from(caseFlowCreationRequirements)
      .orderBy(
        asc(caseFlowCreationRequirements.targetQueueId),
        asc(caseFlowCreationRequirements.createdAt),
      ),
  ])

  return {
    revision: revisionRow?.revision ?? 1,
    queues: queueRows,
    startRules,
    closeTriggers,
    closeBlockers,
    creationRequirements,
  }
}

export async function updateCaseFlowConfiguration(
  input: UpdateCaseFlowConfigurationInput,
) {
  const value = updateCaseFlowConfigurationSchema.parse(input)
  const now = new Date()

  await getDb().transaction(async (tx) => {
    const [bumped] = await tx
      .update(flowConfigurationRevisions)
      .set({
        revision: sql`${flowConfigurationRevisions.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(flowConfigurationRevisions.id, 1),
          eq(flowConfigurationRevisions.revision, value.revision),
        ),
      )
      .returning({ revision: flowConfigurationRevisions.revision })

    if (!bumped) {
      const current = await tx.query.flowConfigurationRevisions.findFirst({
        where: eq(flowConfigurationRevisions.id, 1),
        columns: { revision: true },
      })
      throw new AppError(
        409,
        'Case flow configuration was updated by someone else. Reload and try again.',
        { revision: current?.revision ?? value.revision },
      )
    }

    const queueById = await assertReferencedQueuesExistTx(tx, value)

    await syncStartRules(tx, value.startRules, now)
    await syncCloseTriggers(tx, value.closeTriggers, now)
    await syncCloseBlockers(tx, value.closeBlockers, now)
    await syncCreationRequirements(tx, value.creationRequirements, now)

    await assertActiveFlowGraphValid(tx, value, queueById)
  })

  return getCaseFlowConfiguration()
}

async function syncStartRules(
  tx: DbTransaction,
  rules: UpdateCaseFlowConfigurationInput['startRules'],
  now: Date,
) {
  const existing = await tx
    .select({ id: caseFlowStartRules.id })
    .from(caseFlowStartRules)
  const existingIds = new Set(existing.map((row) => row.id))
  const keepIds = new Set<string>()

  for (const rule of rules) {
    if (rule.id) {
      if (!existingIds.has(rule.id)) {
        throw new AppError(400, `Unknown start rule id: ${rule.id}`)
      }
      keepIds.add(rule.id)
      await tx
        .update(caseFlowStartRules)
        .set({
          targetQueueId: rule.targetQueueId,
          order: rule.order,
          isActive: rule.isActive,
          updatedAt: now,
        })
        .where(eq(caseFlowStartRules.id, rule.id))
      continue
    }

    await tx.insert(caseFlowStartRules).values({
      targetQueueId: rule.targetQueueId,
      order: rule.order,
      isActive: rule.isActive,
      updatedAt: now,
    })
  }

  const deactivateIds = existing
    .map((row) => row.id)
    .filter((id) => !keepIds.has(id))
  if (deactivateIds.length > 0) {
    await tx
      .update(caseFlowStartRules)
      .set({ isActive: false, updatedAt: now })
      .where(inArray(caseFlowStartRules.id, deactivateIds))
  }
}

async function syncCloseTriggers(
  tx: DbTransaction,
  rules: UpdateCaseFlowConfigurationInput['closeTriggers'],
  now: Date,
) {
  const existing = await tx
    .select({ id: caseFlowCloseTriggers.id })
    .from(caseFlowCloseTriggers)
  const existingIds = new Set(existing.map((row) => row.id))
  const keepIds = new Set<string>()

  for (const rule of rules) {
    if (rule.id) {
      if (!existingIds.has(rule.id)) {
        throw new AppError(400, `Unknown close trigger id: ${rule.id}`)
      }
      keepIds.add(rule.id)
      await tx
        .update(caseFlowCloseTriggers)
        .set({
          sourceQueueId: rule.sourceQueueId,
          targetQueueId: rule.targetQueueId,
          order: rule.order,
          isActive: rule.isActive,
          updatedAt: now,
        })
        .where(eq(caseFlowCloseTriggers.id, rule.id))
      continue
    }

    await tx.insert(caseFlowCloseTriggers).values({
      sourceQueueId: rule.sourceQueueId,
      targetQueueId: rule.targetQueueId,
      order: rule.order,
      isActive: rule.isActive,
      updatedAt: now,
    })
  }

  const deactivateIds = existing
    .map((row) => row.id)
    .filter((id) => !keepIds.has(id))
  if (deactivateIds.length > 0) {
    await tx
      .update(caseFlowCloseTriggers)
      .set({ isActive: false, updatedAt: now })
      .where(inArray(caseFlowCloseTriggers.id, deactivateIds))
  }
}

async function syncCloseBlockers(
  tx: DbTransaction,
  rules: UpdateCaseFlowConfigurationInput['closeBlockers'],
  now: Date,
) {
  const existing = await tx
    .select({ id: caseFlowCloseBlockers.id })
    .from(caseFlowCloseBlockers)
  const existingIds = new Set(existing.map((row) => row.id))
  const keepIds = new Set<string>()

  for (const rule of rules) {
    if (rule.id) {
      if (!existingIds.has(rule.id)) {
        throw new AppError(400, `Unknown close requirement id: ${rule.id}`)
      }
      keepIds.add(rule.id)
      await tx
        .update(caseFlowCloseBlockers)
        .set({
          blockedQueueId: rule.blockedQueueId,
          prerequisiteQueueId: rule.prerequisiteQueueId,
          isActive: rule.isActive,
          updatedAt: now,
        })
        .where(eq(caseFlowCloseBlockers.id, rule.id))
      continue
    }

    await tx.insert(caseFlowCloseBlockers).values({
      blockedQueueId: rule.blockedQueueId,
      prerequisiteQueueId: rule.prerequisiteQueueId,
      isActive: rule.isActive,
      updatedAt: now,
    })
  }

  const deactivateIds = existing
    .map((row) => row.id)
    .filter((id) => !keepIds.has(id))
  if (deactivateIds.length > 0) {
    await tx
      .update(caseFlowCloseBlockers)
      .set({ isActive: false, updatedAt: now })
      .where(inArray(caseFlowCloseBlockers.id, deactivateIds))
  }
}

async function syncCreationRequirements(
  tx: DbTransaction,
  rules: UpdateCaseFlowConfigurationInput['creationRequirements'],
  now: Date,
) {
  const existing = await tx
    .select({ id: caseFlowCreationRequirements.id })
    .from(caseFlowCreationRequirements)
  const existingIds = new Set(existing.map((row) => row.id))
  const keepIds = new Set<string>()

  for (const rule of rules) {
    if (rule.id) {
      if (!existingIds.has(rule.id)) {
        throw new AppError(
          400,
          `Unknown creation requirement id: ${rule.id}`,
        )
      }
      keepIds.add(rule.id)
      await tx
        .update(caseFlowCreationRequirements)
        .set({
          targetQueueId: rule.targetQueueId,
          prerequisiteQueueId: rule.prerequisiteQueueId,
          isActive: rule.isActive,
          updatedAt: now,
        })
        .where(eq(caseFlowCreationRequirements.id, rule.id))
      continue
    }

    await tx.insert(caseFlowCreationRequirements).values({
      targetQueueId: rule.targetQueueId,
      prerequisiteQueueId: rule.prerequisiteQueueId,
      isActive: rule.isActive,
      updatedAt: now,
    })
  }

  const deactivateIds = existing
    .map((row) => row.id)
    .filter((id) => !keepIds.has(id))
  if (deactivateIds.length > 0) {
    await tx
      .update(caseFlowCreationRequirements)
      .set({ isActive: false, updatedAt: now })
      .where(inArray(caseFlowCreationRequirements.id, deactivateIds))
  }
}

async function assertReferencedQueuesExistTx(
  tx: DbTransaction,
  input: UpdateCaseFlowConfigurationInput,
) {
  const queueIds = new Set<string>()
  for (const rule of input.startRules) queueIds.add(rule.targetQueueId)
  for (const rule of input.closeTriggers) {
    queueIds.add(rule.sourceQueueId)
    queueIds.add(rule.targetQueueId)
  }
  for (const rule of input.closeBlockers) {
    queueIds.add(rule.blockedQueueId)
    queueIds.add(rule.prerequisiteQueueId)
  }
  for (const rule of input.creationRequirements) {
    queueIds.add(rule.targetQueueId)
    queueIds.add(rule.prerequisiteQueueId)
  }

  if (queueIds.size === 0) return new Map<string, QueueRef>()

  const existingRows = await tx
    .select({
      id: queues.id,
      name: queues.name,
      lifecycle: queues.lifecycle,
      isActive: queues.isActive,
    })
    .from(queues)
    .where(inArray(queues.id, Array.from(queueIds)))

  if (existingRows.length !== queueIds.size) {
    throw new AppError(400, 'One or more selected queues do not exist.')
  }

  return new Map(existingRows.map((row) => [row.id, row]))
}

async function assertActiveFlowGraphValid(
  tx: DbTransaction,
  input: UpdateCaseFlowConfigurationInput,
  queueById: Map<string, QueueRef>,
) {
  const activeStartRules = input.startRules.filter((rule) => rule.isActive)
  const activeCloseTriggers = input.closeTriggers.filter((rule) => rule.isActive)
  const activeCloseBlockers = input.closeBlockers.filter((rule) => rule.isActive)
  const activeCreationRequirements = input.creationRequirements.filter(
    (rule) => rule.isActive,
  )

  const referencedQueueIds = new Set<string>()
  for (const rule of activeStartRules) referencedQueueIds.add(rule.targetQueueId)
  for (const rule of activeCloseTriggers) {
    referencedQueueIds.add(rule.sourceQueueId)
    referencedQueueIds.add(rule.targetQueueId)
  }
  for (const rule of activeCloseBlockers) {
    referencedQueueIds.add(rule.blockedQueueId)
    referencedQueueIds.add(rule.prerequisiteQueueId)
  }
  for (const rule of activeCreationRequirements) {
    referencedQueueIds.add(rule.targetQueueId)
    referencedQueueIds.add(rule.prerequisiteQueueId)
  }

  const inactiveQueues = Array.from(referencedQueueIds)
    .map((id) => queueById.get(id))
    .filter(
      (queue): queue is QueueRef =>
        queue != null && queue.lifecycle !== 'active',
    )

  if (inactiveQueues.length > 0) {
    throw new AppError(
      400,
      `Active rules cannot reference inactive queues: ${formatQueueList(inactiveQueues)}.`,
      {
        queueIds: inactiveQueues.map((queue) => queue.id),
        queueNames: inactiveQueues.map((queue) => queue.name),
      },
    )
  }

  if (referencedQueueIds.size > 0) {
    const stageRows = await tx
      .select({
        queueId: queueStages.queueId,
        category: queueStages.category,
        order: queueStages.order,
      })
      .from(queueStages)
      .where(inArray(queueStages.queueId, Array.from(referencedQueueIds)))
      .orderBy(asc(queueStages.queueId), asc(queueStages.order))

    const readinessByQueue = new Map<string, StageReadiness>()
    for (const queueId of referencedQueueIds) {
      readinessByQueue.set(queueId, {
        queueId,
        hasInitial: false,
        hasTerminal: false,
      })
    }

    const firstOrderSeen = new Set<string>()
    for (const stage of stageRows) {
      const readiness = readinessByQueue.get(stage.queueId)
      if (!readiness) continue
      if (!firstOrderSeen.has(stage.queueId)) {
        firstOrderSeen.add(stage.queueId)
        readiness.hasInitial = true
      }
      if (stage.category === 'new') readiness.hasInitial = true
      if (stage.category === 'closed') readiness.hasTerminal = true
    }

    const missingInitial = Array.from(readinessByQueue.values())
      .filter((row) => !row.hasInitial)
      .map((row) => queueById.get(row.queueId))
      .filter((queue): queue is QueueRef => Boolean(queue))
    if (missingInitial.length > 0) {
      throw new AppError(
        400,
        `Queues are missing a usable initial stage: ${formatQueueList(missingInitial)}.`,
        {
          queueIds: missingInitial.map((queue) => queue.id),
          queueNames: missingInitial.map((queue) => queue.name),
        },
      )
    }

    const missingTerminal = Array.from(readinessByQueue.values())
      .filter((row) => !row.hasTerminal)
      .map((row) => queueById.get(row.queueId))
      .filter((queue): queue is QueueRef => Boolean(queue))
    if (missingTerminal.length > 0) {
      throw new AppError(
        400,
        `Queues are missing a usable terminal stage: ${formatQueueList(missingTerminal)}.`,
        {
          queueIds: missingTerminal.map((queue) => queue.id),
          queueNames: missingTerminal.map((queue) => queue.name),
        },
      )
    }
  }

  const creationCycle = findDependencyCycle(
    activeCreationRequirements.map((rule) => ({
      from: rule.targetQueueId,
      to: rule.prerequisiteQueueId,
    })),
  )
  if (creationCycle) {
    throwGraphCycleError(
      'Creation requirements contain a cycle',
      creationCycle,
      queueById,
    )
  }

  const closeBlockerCycle = findDependencyCycle(
    activeCloseBlockers.map((rule) => ({
      from: rule.blockedQueueId,
      to: rule.prerequisiteQueueId,
    })),
  )
  if (closeBlockerCycle) {
    throwGraphCycleError(
      'Close requirements contain a cycle',
      closeBlockerCycle,
      queueById,
    )
  }

  const creationRequirementTargets = new Set(
    activeCreationRequirements.map((rule) => rule.targetQueueId),
  )
  const impossibleStartTargets = activeStartRules
    .filter((rule) => creationRequirementTargets.has(rule.targetQueueId))
    .map((rule) => queueById.get(rule.targetQueueId))
    .filter((queue): queue is QueueRef => Boolean(queue))

  if (impossibleStartTargets.length > 0) {
    throw new AppError(
      400,
      `First-case queues cannot also require another case to close first: ${formatQueueList(impossibleStartTargets)}.`,
      {
        queueIds: impossibleStartTargets.map((queue) => queue.id),
        queueNames: impossibleStartTargets.map((queue) => queue.name),
      },
    )
  }

  const blockerPairs = new Set(
    activeCloseBlockers.map(
      (rule) => `${rule.blockedQueueId}:${rule.prerequisiteQueueId}`,
    ),
  )
  const impossibleTriggers = activeCloseTriggers.filter((rule) =>
    blockerPairs.has(`${rule.sourceQueueId}:${rule.targetQueueId}`),
  )

  if (impossibleTriggers.length > 0) {
    const details = impossibleTriggers.map((rule) => {
      const source = queueById.get(rule.sourceQueueId)
      const target = queueById.get(rule.targetQueueId)
      return {
        sourceQueueId: rule.sourceQueueId,
        sourceQueueName: source?.name ?? rule.sourceQueueId,
        targetQueueId: rule.targetQueueId,
        targetQueueName: target?.name ?? rule.targetQueueId,
      }
    })
    throw new AppError(
      400,
      `Close triggers conflict with close requirements: ${details
        .map(
          (item) =>
            `${item.sourceQueueName} cannot both wait for and open ${item.targetQueueName}`,
        )
        .join('; ')}.`,
      {
        conflicts: details,
        queueIds: details.flatMap((item) => [
          item.sourceQueueId,
          item.targetQueueId,
        ]),
        queueNames: details.flatMap((item) => [
          item.sourceQueueName,
          item.targetQueueName,
        ]),
      },
    )
  }
}

function findDependencyCycle(
  edges: Array<{ from: string; to: string }>,
): string[] | null {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  let cycle: string[] | null = null

  function dfs(node: string, path: string[]): boolean {
    if (visiting.has(node)) {
      const start = path.indexOf(node)
      cycle = [...path.slice(start), node]
      return true
    }
    if (visited.has(node)) return false

    visiting.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (dfs(next, [...path, node])) return true
    }
    visiting.delete(node)
    visited.add(node)
    return false
  }

  for (const node of adjacency.keys()) {
    if (dfs(node, [])) return cycle
  }
  return null
}

function throwGraphCycleError(
  prefix: string,
  cycle: string[],
  queueById: Map<string, QueueRef>,
): never {
  const names = cycle.map(
    (queueId) => queueById.get(queueId)?.name ?? queueId,
  )
  throw new AppError(400, `${prefix}: ${names.join(' → ')}.`, {
    cycle: cycle,
    cyclePath: names,
    queueIds: Array.from(new Set(cycle)),
    queueNames: Array.from(new Set(names)),
  })
}

function formatQueueList(queuesToFormat: QueueRef[]) {
  return queuesToFormat
    .map((queue) => `${queue.name} (${queue.id})`)
    .join(', ')
}

async function uploadConfigurationDraft(input: {
  folderPath: string[]
  file: File
}) {
  validateDraftFile(input.file)
  const storage = new GoogleDriveStorageProvider()
  let folder = await storage.createMerchantFolder(
    input.folderPath[0] ?? 'Configuration',
  )

  for (const folderName of input.folderPath.slice(1)) {
    folder = await storage.createFolder(folder.folderId, folderName)
  }

  return storage.uploadFile(folder.folderId, {
    file: input.file,
    fileName: input.file.name,
    mimeType: input.file.type || 'application/octet-stream',
  })
}

function validateDraftFile(file: File) {
  if (file.size > MAX_DRAFT_BYTES) {
    throw new AppError(400, 'Draft file must be 5 MB or smaller.')
  }

  const mimeType = file.type || 'application/octet-stream'
  const extension = getFileExtension(file.name)
  if (!DRAFT_MIME_TYPES.has(mimeType) && !DRAFT_EXTENSIONS.has(extension)) {
    throw new AppError(400, 'Draft file must be a PDF, DOC, or DOCX file.')
  }
}

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

function getBusinessTypeLabel(businessType: BusinessType) {
  return (
    BUSINESS_TYPE_OPTIONS.find((option) => option.value === businessType)
      ?.label ?? businessType
  )
}
