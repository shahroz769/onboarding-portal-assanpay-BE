import { eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { caseFiles } from '../../db/schema'
import type { Merchant } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { supersedeStorageObjects } from '../../lib/storage/ownership'
import { getEmailSendingModeSettings } from '../configuration/configuration.service'
import {
  DOCUMENT_TYPE_LABELS,
  MERCHANT_FIELD_LABELS,
  getDocumentIdFromFieldName,
  isDocumentFieldName,
} from './field-labels'
import type { EmailRecipientType } from './cases.schemas'
import type { MidCreationCredentials } from './case-detail-lookups'
import { getClientPayoutRateLabel } from './case-detail-lookups'
import { ensurePrivateInternalCaseFolder } from './case-drive-folders'
import { getCaseFileStorage } from './case-storage'
import { validateEmailProofFile } from './case-upload-validation'

export function getRejectionLabel(
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

export function formatExpiryDate(date: Date): string {
  if (date.getFullYear() >= 9999) return 'no expiry'
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(date)
}

export function formatExpiryLine(expiresAt: string): string {
  if (expiresAt.trim().toLowerCase() === 'no expiry') return ''
  return `\n\nThis link expires ${expiresAt}.`
}

export function formatEmailDateTime(date: Date): string {
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

export type ServerIntegrationDetails = {
  baseUrl: string
  callbackIp: string
}

export function resolveCustomWebsiteServerIntegration(
  websiteCms: string,
  settings: { serverBaseUrl: string; serverCallbackIp: string },
): ServerIntegrationDetails | null {
  if (websiteCms !== 'custom_website') return null
  return {
    baseUrl: settings.serverBaseUrl,
    callbackIp: settings.serverCallbackIp,
  }
}

// ─── Email mode guards ────────────────────────────────────────────────────────

export async function assertAutoEmailEnabled(): Promise<void> {
  const mode = await getEmailSendingModeSettings()
  if (!mode.autoEnabled) {
    throw new AppError(
      403,
      'Automatic email sending is disabled. Use the manual email workflow.',
    )
  }
}

export async function assertManualEmailEnabled(): Promise<void> {
  const mode = await getEmailSendingModeSettings()
  if (!mode.manualEnabled) {
    throw new AppError(
      403,
      'Manual email sending is disabled. Use the automatic email workflow.',
    )
  }
}

// ─── Email proof upload helper ────────────────────────────────────────────────

export function resolveMerchantEmailRecipient(
  merchant: { submitterEmail: string | null; businessEmail: string | null },
  recipientEmailType: EmailRecipientType = 'submitter',
) {
  const email =
    recipientEmailType === 'business'
      ? merchant.businessEmail
      : merchant.submitterEmail
  const label =
    recipientEmailType === 'business' ? 'business email' : 'submitter email'

  if (!email) {
    throw new AppError(400, `No ${label} is on file for this merchant.`)
  }

  return { email, recipientEmailType }
}

export async function uploadEmailProofFile(
  caseId: string,
  userId: string,
  file: File,
  fileKind: string,
  caseNumber: string,
  merchantId: string,
  merchantName: string,
  queueName: string | null | undefined,
) {
  const db = getDb()
  const storage = getCaseFileStorage()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId,
    merchantName,
    caseNumber,
    queueName,
    section: 'Email Proofs',
    storage,
  })
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

export function buildResubmissionEmailBody(params: {
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
${resubmissionUrl}${formatExpiryLine(expiresAt)}

If you have any questions, please reply to this email.

Best regards,
AssanPay Onboarding Team`
}

export function buildAgreementEmailBody(params: {
  merchantName: string
  ownerName: string
  agreementUrl: string
  expiresAt: string
  remarks: string | null
}): string {
  const { merchantName, ownerName, agreementUrl, expiresAt, remarks } = params
  let body = `Hi ${ownerName},

The link below is unique to your onboarding case. Please review the agreement for ${merchantName} carefully and upload the fully signed copy, including every page, so we can move to the next step.

Before Go-Live can proceed, send the signed physical agreement to AssanPay Head Office. This physical agreement copy is required for live activation.`

  if (remarks) {
    body += `\n\nAdditional notes from our team:\n${remarks}`
  }

  body += `\n\nAgreement link:\n${agreementUrl}${formatExpiryLine(expiresAt)}

If you have any questions, please reply to this email.

Best regards,
AssanPay Onboarding Team`

  return body
}

export function buildMidCreationEmailBody(params: {
  merchantName: string
  portalEmail: string
  portalPassword: string
  merchantPortalUrl: string
  goLiveUrl: string
  availableAt: string
  goLiveAvailabilityHours: number | null
  serverIntegration?: ServerIntegrationDetails | null
  testingLimits: {
    transactionLimit: number
    dailyLimit: number
    monthlyLimit: number
  }
  paymentMethods: Array<{ label: string; commissionRate: number }>
  payoutRate: string
  payoutRateLabel: string
}): string {
  const {
    merchantName,
    portalEmail,
    portalPassword,
    merchantPortalUrl,
    goLiveUrl,
    availableAt,
    goLiveAvailabilityHours,
    testingLimits,
    paymentMethods,
    payoutRate,
    payoutRateLabel,
  } = params
  const goLiveAvailabilityLabel =
    goLiveAvailabilityHours == null
      ? 'immediately'
      : `after ${goLiveAvailabilityHours}h`
  return `AssanPay Merchant Portal Credentials for ${merchantName}

Portal Login: ${merchantPortalUrl}
Email: ${portalEmail}
Password: ${portalPassword}
${
  params.serverIntegration
    ? `
Custom Website Server Integration:
Server Base URL: ${params.serverIntegration.baseUrl}
Server Callback IP: ${params.serverIntegration.callbackIp}
`
    : ''
}

For your security, update this temporary password after your first login.

Testing Limits:
• Per Transaction: PKR ${testingLimits.transactionLimit.toLocaleString()}
• Daily: PKR ${testingLimits.dailyLimit.toLocaleString()}
• Monthly: PKR ${testingLimits.monthlyLimit.toLocaleString()}

Rates:
${paymentMethods.map((method) => `• ${method.label}: ${method.commissionRate}%`).join('\n')}
• ${payoutRateLabel}: ${payoutRate}

Go-Live Link (available ${goLiveAvailabilityLabel}):
${goLiveUrl}
Available at: ${availableAt}

Before Go-Live can proceed, send the signed physical agreement to AssanPay Head Office. This physical agreement copy is required for live activation.

Please keep your credentials secure and do not share them with anyone.

Best regards,
AssanPay Onboarding Team`
}

export function buildMidCreationMessageBody(params: {
  merchantName: string
  portalEmail: string
  portalPassword: string
  merchantPortalUrl: string
  goLiveUrl: string
  availableAt: string
  goLiveAvailabilityHours: number | null
  serverIntegration?: ServerIntegrationDetails | null
  testingLimits: {
    collectionMin: number
    collectionMax: number
    disbursementMin: number
    disbursementMax: number
  }
  paymentMethods: Array<{
    label: string
    testing: { min: number; max: number }
    commissionRate: number
  }>
  payoutRate: string
  payoutRateLabel: string
}): string {
  const goLiveAvailabilityLabel =
    params.goLiveAvailabilityHours == null
      ? 'immediately'
      : `after ${params.goLiveAvailabilityHours}h`

  return `AssanPay Merchant Portal Credentials for ${params.merchantName}

Portal Login: ${params.merchantPortalUrl}
Email: ${params.portalEmail}
Password: ${params.portalPassword}
${
  params.serverIntegration
    ? `
Custom Website Server Integration:
- Server Base URL: ${params.serverIntegration.baseUrl}
- Server Callback IP: ${params.serverIntegration.callbackIp}
`
    : ''
}

For your security, update this temporary password after your first login.

Testing Limits:
${params.paymentMethods.map((method) => `- ${method.label} collection: PKR ${method.testing.min.toLocaleString()}-${method.testing.max.toLocaleString()}`).join('\n')}
- Disbursement: PKR ${params.testingLimits.disbursementMin.toLocaleString()}-${params.testingLimits.disbursementMax.toLocaleString()}

Rates:
${params.paymentMethods.map((method) => `- ${method.label}: ${method.commissionRate}%`).join('\n')}
- ${params.payoutRateLabel}: ${params.payoutRate}

Go-Live Link (available ${goLiveAvailabilityLabel}):
${params.goLiveUrl}
Available at: ${params.availableAt}

Before Go-Live can proceed, send the signed physical agreement to AssanPay Head Office. This physical agreement copy is required for live activation.

Please keep your credentials secure and do not share them with anyone.

Best regards,
AssanPay Onboarding Team`
}

export function buildLiveActivationEmailBody(params: {
  merchantName: string
  merchantPortalUrl: string
  liveLimits: {
    collectionMin: number
    collectionMax: number
    disbursementMin: number
    disbursementMax: number
  }
  paymentMethods: Array<{
    label: string
    live: { min: number; max: number }
  }>
}) {
  const { merchantName, merchantPortalUrl, liveLimits } = params
  return `AssanPay account is live for ${merchantName}

Congratulations, ${merchantName}. Your AssanPay merchant account is live now and ready for production transactions.

Merchant Portal Link: ${merchantPortalUrl}

Live Limits Per Transaction
${params.paymentMethods.map((method) => `- ${method.label} collection: PKR ${method.live.min.toLocaleString()}-${method.live.max.toLocaleString()}`).join('\n')}
- Disbursement: PKR ${liveLimits.disbursementMin.toLocaleString()}-${liveLimits.disbursementMax.toLocaleString()}

You can use the merchant portal to monitor live activity and manage your AssanPay merchant account.

If you need any help, just reply to this email.

- AssanPay Onboarding Team`
}
