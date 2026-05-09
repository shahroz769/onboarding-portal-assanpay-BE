import { eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  agreementDraftTemplates,
  configurationSettings,
  subMerchantDraftTemplates,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import { getAgreementDraftForMerchantType as getFallbackAgreementDraftForMerchantType } from '../cases/agreement.config'
import {
  BUSINESS_TYPE_OPTIONS,
  businessTypeSchema,
  limitsAndMdrSettingsSchema,
  linkDeadlineSettingsSchema,
} from './configuration.schemas'
import type {
  BusinessType,
  LimitsAndMdrSettings,
  LinkDeadlineSettings,
} from './configuration.schemas'

const LIMITS_AND_MDR_KEY = 'limits-and-mdr'
const LINK_DEADLINES_KEY = 'link-deadlines'
const MAX_DRAFT_BYTES = 5 * 1024 * 1024
const DRAFT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

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

export async function getConfigurationOverview() {
  const [limitsAndMdr, linkDeadlines, agreementDrafts, subMerchants] =
    await Promise.all([
      getLimitsAndMdrSettings(),
      getLinkDeadlineSettings(),
      listAgreementDrafts(),
      listSubMerchantDrafts(),
    ])

  return {
    limitsAndMdr,
    linkDeadlines,
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
  file: File
}) {
  const name = input.name.trim()
  if (!name) {
    throw new AppError(400, 'Sub-merchant name is required.')
  }

  const uploaded = await uploadConfigurationDraft({
    folderPath: ['Configuration', 'Sub-Merchants', name],
    file: input.file,
  })

  await getDb().insert(subMerchantDraftTemplates).values({
    name,
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
  if (!DRAFT_MIME_TYPES.has(mimeType)) {
    throw new AppError(400, 'Draft file must be a PDF, DOC, or DOCX file.')
  }
}

function getBusinessTypeLabel(businessType: BusinessType) {
  return (
    BUSINESS_TYPE_OPTIONS.find((option) => option.value === businessType)
      ?.label ?? businessType
  )
}
