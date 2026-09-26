import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  agreementDraftTemplates,
  caseFlowCloseBlockers,
  caseFlowVersions,
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
import { assertFileSizeLimit } from '../../lib/storage/file-limits'
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
  payoutMethodSettingsSchema,
  updateCaseFlowConfigurationSchema,
} from './configuration.schemas'
import {
  buildCaseFlowDependencyEdges,
  findDependencyCycle,
} from './case-flow-graph'
import type {
  BusinessType,
  EmailSendingModeSettings,
  LimitsAndMdrSettings,
  LinkDeadlineSettings,
  MerchantPortalSettings,
  PaymentMethodSettings,
  PayoutMethodSettings,
  UpdateCaseFlowConfigurationInput,
} from './configuration.schemas'

const LIMITS_AND_MDR_KEY = 'limits-and-mdr'
const LINK_DEADLINES_KEY = 'link-deadlines'
const EMAIL_SENDING_MODE_KEY = 'email-sending-mode'
const MERCHANT_PORTAL_KEY = 'merchant-portal'
const PAYMENT_METHODS_KEY = 'payment-methods'
const PAYOUT_METHODS_KEY = 'payout-methods'
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
  serverBaseUrl: '',
  serverCallbackIp: '',
  officeAddress: '',
  whatsappSupportNumber: '',
  supportEmail: '',
  legalEmail: '',
}

export const defaultPaymentMethodSettings: PaymentMethodSettings = []
export const defaultPayoutMethodSettings: PayoutMethodSettings = []

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
  let isLegacyCombinedFallback = false
  let row = await getDb().query.configurationSettings.findFirst({
    where: eq(configurationSettings.key, key),
  })

  if (!row && key === PAYOUT_METHODS_KEY) {
    row = await getDb().query.configurationSettings.findFirst({
      where: eq(configurationSettings.key, PAYMENT_METHODS_KEY),
    })
    isLegacyCombinedFallback = Boolean(row)
  }

  if (!row) {
    return legacyMode === 'collection'
      ? defaultPaymentMethodSettings
      : defaultPayoutMethodSettings
  }

  if (
    isLegacyCombinedFallback &&
    (!Array.isArray(row.value) ||
      !row.value.some(
        (method) =>
          method != null &&
          typeof method === 'object' &&
          ('collectionEnabled' in method ||
            'disbursementEnabled' in method ||
            'key' in method),
      ))
  ) {
    return defaultPayoutMethodSettings
  }

  const parser =
    legacyMode === 'collection'
      ? paymentMethodSettingsSchema
      : payoutMethodSettingsSchema
  const parsed = parser.safeParse(row.value)
  if (parsed.success) return parsed.data

  const configuredLimits = await getLimitsAndMdrSettings()

  const legacyMethods = Array.isArray(row.value) ? row.value : []
  const migrated = legacyMethods.flatMap((method) => {
    if (!method || typeof method !== 'object') return []
    const record = method as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const id =
      typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : typeof record.key === 'string' && record.key.trim()
          ? record.key.trim()
          : label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const enabled =
      legacyMode === 'collection'
        ? record.collectionEnabled !== false
        : record.disbursementEnabled !== false

    if (!label || !id || !enabled) return []
    const testingFallback =
      legacyMode === 'collection'
        ? {
            min: configuredLimits.testing.collectionMin,
            max: configuredLimits.testing.collectionMax,
          }
        : {
            min: configuredLimits.testing.disbursementMin,
            max: configuredLimits.testing.disbursementMax,
          }
    const liveFallback =
      legacyMode === 'collection'
        ? {
            min: configuredLimits.live.collectionMin,
            max: configuredLimits.live.collectionMax,
          }
        : {
            min: configuredLimits.live.disbursementMin,
            max: configuredLimits.live.disbursementMax,
          }
    return [
      {
        id,
        label,
        testing: readLegacyCollectionRange(record.testing, testingFallback),
        live: readLegacyCollectionRange(record.live, liveFallback),
        commissionRate:
          typeof record.commissionRate === 'number'
            ? record.commissionRate
            : legacyMode === 'disbursement'
              ? configuredLimits.rates.payout
              : /card/i.test(label)
                ? configuredLimits.rates.cardDefault
                : configuredLimits.rates.eWallets,
      },
    ]
  })

  const migratedParsed = parser.safeParse(migrated)
  return migratedParsed.success ? migratedParsed.data : []
}

function readLegacyCollectionRange(
  value: unknown,
  fallback: { min: number; max: number },
) {
  if (!value || typeof value !== 'object') return fallback
  const range = value as Record<string, unknown>
  return typeof range.min === 'number' && typeof range.max === 'number'
    ? { min: range.min, max: range.max }
    : fallback
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

export async function getMerchantPortalSettings() {
  const row = await getDb().query.configurationSettings.findFirst({
    where: eq(configurationSettings.key, MERCHANT_PORTAL_KEY),
  })
  const parsed = merchantPortalSettingsSchema.safeParse(row?.value)
  const value = parsed.success ? parsed.data : defaultMerchantPortalSettings
  const storedValue =
    row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? (row.value as Record<string, unknown>)
      : null
  const isCompleteStoredValue =
    storedValue !== null &&
    Object.entries(value).every(
      ([key, fieldValue]) => storedValue[key] === fieldValue,
    )

  if (!isCompleteStoredValue) {
    await writeSetting(MERCHANT_PORTAL_KEY, value)
  }

  return value
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

export async function updatePayoutMethodSettings(input: PayoutMethodSettings) {
  const value = payoutMethodSettingsSchema.parse(input)
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

  // Check before uploading so a duplicate never leaves an orphaned Drive file.
  const [conflict] = await getDb()
    .select({
      name: subMerchantDraftTemplates.name,
      sellerCode: subMerchantDraftTemplates.sellerCode,
    })
    .from(subMerchantDraftTemplates)
    .where(
      or(
        sql`lower(${subMerchantDraftTemplates.name}) = lower(${name})`,
        sql`lower(${subMerchantDraftTemplates.sellerCode}) = lower(${sellerCode})`,
      ),
    )
    .limit(1)
  if (conflict) {
    throw new AppError(
      409,
      conflict.sellerCode.toLowerCase() === sellerCode.toLowerCase()
        ? 'A sub-merchant with this Seller Code already exists.'
        : 'A sub-merchant with this name already exists.',
    )
  }

  const uploaded = await uploadConfigurationDraft({
    folderPath: ['Configuration', 'Sub-Merchants', name],
    file: input.file,
  })

  try {
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
  } catch (error) {
    // A concurrent create won the unique index; drop this attempt's upload.
    await new GoogleDriveStorageProvider()
      .deleteFile(uploaded.fileId)
      .catch((cleanupError) =>
        console.error('[configuration] Draft cleanup failed:', cleanupError),
      )
    throw error
  }

  return listSubMerchantDrafts()
}

export async function getCaseFlowConfiguration(versionId?: number) {
  return getDb().transaction((tx) => readCaseFlowConfiguration(tx, versionId))
}

async function readCaseFlowConfiguration(
  tx: DbTransaction,
  versionId?: number,
) {
  const [current] = await tx
    .select()
    .from(flowConfigurationRevisions)
    .where(eq(flowConfigurationRevisions.id, 1))
    .for('share')
  if (!current)
    throw new AppError(409, 'Case flow versioning is not initialized.')
  const selectedVersionId = versionId ?? current.activeFlowVersionId
  const version = await tx.query.caseFlowVersions.findFirst({
    where: and(
      eq(caseFlowVersions.id, selectedVersionId),
      isNotNull(caseFlowVersions.publishedAt),
    ),
  })
  if (!version) throw new AppError(404, 'Published flow version not found.')
  const versions = await tx
    .select({
      id: caseFlowVersions.id,
      publishedAt: caseFlowVersions.publishedAt,
      publishedBy: caseFlowVersions.publishedBy,
      changeNote: caseFlowVersions.changeNote,
    })
    .from(caseFlowVersions)
    .where(isNotNull(caseFlowVersions.publishedAt))
    .orderBy(asc(caseFlowVersions.id))

  const [
    queueRows,
    startRules,
    closeTriggers,
    closeBlockers,
    creationRequirements,
  ] = await Promise.all([
    tx
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
    tx
      .select({
        id: caseFlowStartRules.id,
        targetQueueId: caseFlowStartRules.targetQueueId,
        order: caseFlowStartRules.order,
        isActive: caseFlowStartRules.isActive,
      })
      .from(caseFlowStartRules)
      .where(eq(caseFlowStartRules.flowVersionId, selectedVersionId))
      .orderBy(
        asc(caseFlowStartRules.order),
        asc(caseFlowStartRules.createdAt),
      ),
    tx
      .select({
        id: caseFlowCloseTriggers.id,
        sourceQueueId: caseFlowCloseTriggers.sourceQueueId,
        targetQueueId: caseFlowCloseTriggers.targetQueueId,
        order: caseFlowCloseTriggers.order,
        isActive: caseFlowCloseTriggers.isActive,
      })
      .from(caseFlowCloseTriggers)
      .where(eq(caseFlowCloseTriggers.flowVersionId, selectedVersionId))
      .orderBy(
        asc(caseFlowCloseTriggers.sourceQueueId),
        asc(caseFlowCloseTriggers.order),
        asc(caseFlowCloseTriggers.createdAt),
      ),
    tx
      .select({
        id: caseFlowCloseBlockers.id,
        blockedQueueId: caseFlowCloseBlockers.blockedQueueId,
        prerequisiteQueueId: caseFlowCloseBlockers.prerequisiteQueueId,
        isActive: caseFlowCloseBlockers.isActive,
      })
      .from(caseFlowCloseBlockers)
      .where(eq(caseFlowCloseBlockers.flowVersionId, selectedVersionId))
      .orderBy(
        asc(caseFlowCloseBlockers.blockedQueueId),
        asc(caseFlowCloseBlockers.createdAt),
      ),
    tx
      .select({
        id: caseFlowCreationRequirements.id,
        targetQueueId: caseFlowCreationRequirements.targetQueueId,
        prerequisiteQueueId: caseFlowCreationRequirements.prerequisiteQueueId,
        isActive: caseFlowCreationRequirements.isActive,
      })
      .from(caseFlowCreationRequirements)
      .where(eq(caseFlowCreationRequirements.flowVersionId, selectedVersionId))
      .orderBy(
        asc(caseFlowCreationRequirements.targetQueueId),
        asc(caseFlowCreationRequirements.createdAt),
      ),
  ])

  return {
    revision: current.revision,
    versionId: version.id,
    activeVersionId: current.activeFlowVersionId,
    versions,
    queues:
      version.id === current.activeFlowVersionId
        ? queueRows
        : version.queueSnapshot,
    startRules,
    closeTriggers,
    closeBlockers,
    creationRequirements,
  }
}

export async function updateCaseFlowConfiguration(
  input: UpdateCaseFlowConfigurationInput,
  publishedBy: string,
) {
  const value = updateCaseFlowConfigurationSchema.parse(input)
  return getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(flowConfigurationRevisions)
      .where(eq(flowConfigurationRevisions.id, 1))
      .for('update')
    if (!current || current.revision !== value.revision) {
      throw new AppError(
        409,
        'Case flow configuration was updated by someone else. Reload and try again.',
        {
          revision: current?.revision ?? value.revision,
        },
      )
    }
    const queueById = await assertReferencedQueuesExistTx(tx, value)
    await assertActiveFlowGraphValid(tx, value, queueById)
    const queueSnapshot = await tx
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
      .orderBy(asc(queues.id))
    const [version] = await tx
      .insert(caseFlowVersions)
      .values({
        publishedBy,
        changeNote: value.changeNote ?? null,
        queueSnapshot,
      })
      .returning({ id: caseFlowVersions.id })
    // Editor IDs belong to the previous version; every published rule gets a new ID.
    if (value.startRules.length)
      await tx.insert(caseFlowStartRules).values(
        value.startRules.map(({ id, ...rule }) => ({
          ...rule,
          flowVersionId: version.id,
        })),
      )
    if (value.closeTriggers.length)
      await tx.insert(caseFlowCloseTriggers).values(
        value.closeTriggers.map(({ id, ...rule }) => ({
          ...rule,
          flowVersionId: version.id,
        })),
      )
    if (value.closeBlockers.length)
      await tx.insert(caseFlowCloseBlockers).values(
        value.closeBlockers.map(({ id, ...rule }) => ({
          ...rule,
          flowVersionId: version.id,
        })),
      )
    if (value.creationRequirements.length)
      await tx.insert(caseFlowCreationRequirements).values(
        value.creationRequirements.map(({ id, ...rule }) => ({
          ...rule,
          flowVersionId: version.id,
        })),
      )
    await tx
      .update(caseFlowVersions)
      .set({ publishedAt: new Date() })
      .where(eq(caseFlowVersions.id, version.id))
    await tx
      .update(flowConfigurationRevisions)
      .set({
        activeFlowVersionId: version.id,
        revision: current.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(flowConfigurationRevisions.id, 1))
    // Publishing never wakes or changes jobs pinned to earlier versions.
    return readCaseFlowConfiguration(tx, version.id)
  })
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
    .orderBy(asc(queues.id))
    .for('share')

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
  const activeCloseTriggers = input.closeTriggers.filter(
    (rule) => rule.isActive,
  )
  const activeCloseBlockers = input.closeBlockers.filter(
    (rule) => rule.isActive,
  )
  const activeCreationRequirements = input.creationRequirements.filter(
    (rule) => rule.isActive,
  )

  const referencedQueueIds = new Set<string>()
  for (const rule of activeStartRules)
    referencedQueueIds.add(rule.targetQueueId)
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

  const combinedCycle = findDependencyCycle(
    buildCaseFlowDependencyEdges({
      closeTriggers: activeCloseTriggers,
      creationRequirements: activeCreationRequirements,
      closeBlockers: activeCloseBlockers,
    }),
  )
  if (combinedCycle) {
    throwGraphCycleError(
      'Case flow rules contain a circular dependency',
      combinedCycle,
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

function throwGraphCycleError(
  prefix: string,
  cycle: string[],
  queueById: Map<string, QueueRef>,
): never {
  const names = cycle.map((queueId) => queueById.get(queueId)?.name ?? queueId)
  throw new AppError(400, `${prefix}: ${names.join(' → ')}.`, {
    cycle: cycle,
    cyclePath: names,
    queueIds: Array.from(new Set(cycle)),
    queueNames: Array.from(new Set(names)),
  })
}

function formatQueueList(queuesToFormat: QueueRef[]) {
  return queuesToFormat.map((queue) => `${queue.name} (${queue.id})`).join(', ')
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
  assertFileSizeLimit(file, 'Draft file')

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
