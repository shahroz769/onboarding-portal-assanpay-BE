import { and, eq, inArray, isNull } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  agreementCaseDetails,
  caseFiles,
  caseFieldReviews,
  caseHistory,
  caseResubmissionTokens,
  cases,
  merchantDocuments,
  merchants,
  queues,
  queueStages,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { hashToken } from '../../lib/security'
import { env } from '../../config/env'
import { ensureQueueStages } from '../queues/queue-stage-defaults'
import {
  getLimitsAndMdrSettings,
  getMerchantPortalSettings,
} from '../configuration/configuration.service'
import { getDocumentIdFromFieldName, isDocumentFieldName } from './field-labels'
import { issueToken } from './case-resubmission-tokens.service'
import type {
  SendLiveEmailInput,
  SendMidCreationEmailInput,
  EmailRecipientType,
} from './cases.schemas'
import { assertCanWorkCase } from './case-access.service'

import {
  AGREEMENT_EMAIL_PROOF_KIND,
  AGREEMENT_WHATSAPP_PROOF_KIND,
  LIVE_ACTIVATION_EMAIL_PROOF_KIND,
  LIVE_ACTIVATION_WHATSAPP_PROOF_KIND,
  MID_CREATION_EMAIL_PROOF_KIND,
  MID_CREATION_WHATSAPP_PROOF_KIND,
  RESUBMISSION_EMAIL_PROOF_KIND,
  RESUBMISSION_WHATSAPP_PROOF_KIND,
  type ManualCommunicationChannel,
} from './case-constants'
import {
  assertTestingLimitsAppliedForCredentials,
  buildPortalPassword,
  getClientPayoutRateLabel,
  getMidCreationCredentials,
} from './case-detail-lookups'
import {
  assertManualEmailEnabled,
  buildAgreementEmailBody,
  buildLiveActivationEmailBody,
  buildMidCreationMessageBody,
  buildResubmissionEmailBody,
  getMerchantIntegrationGuideLabel,
  getRejectionLabel,
  resolveCustomWebsiteServerIntegration,
  resolveCaseEmailRecipients,
  resolveMerchantEmailRecipient,
  uploadEmailProofFile,
} from './case-communication-helpers'
import { validateEmailProofFile } from './case-upload-validation'
import { loadAgreementCase } from './agreement-case.service'
import { loadLiveCase } from './live-case.service'
import { loadMidCreationCase } from './mid-case.service'
import { agreementEmailSubject } from '../email/templates/agreement'
import { DOCUMENT_RESUBMISSION_EMAIL_SUBJECT } from '../email/templates/document-resubmission'
import { liveActivationEmailSubject } from '../email/templates/live-activation'
import { midCreationEmailSubject } from '../email/templates/mid-creation'

/** Who else a manual (Gmail) email should go to. */
export type ManualEmailRecipients = {
  cc: string[]
  bcc: string[]
  replyTo: string[]
}

export type ResubmissionEmailPreviewResult = ManualEmailRecipients & {
  recipient: string
  subject: string
  body: string
  tokenId: string
}

export async function getResubmissionEmailPreview(
  caseId: string,
  userId: string,
  input: { recipientEmailType?: EmailRecipientType } = {},
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
      workflowType: queues.workflowType,
      merchantId: cases.merchantId,
      merchantNumber: merchants.merchantNumber,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
      merchantWhatsappNumber: merchants.activeWhatsappNumber,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.workflowType !== 'document_review') {
    throw new AppError(
      400,
      'Resubmission is only available for documents-review cases.',
    )
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can send for resubmission.')
  }
  await assertCanWorkCase(caseId, userId)
  if (row.status !== 'working' && row.status !== 'awaiting_client') {
    throw new AppError(
      400,
      'The case must be in the working or awaiting-merchant stage to send for resubmission.',
    )
  }
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: row.merchantSubmitterEmail,
      businessEmail: row.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

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

  const issued = await issueToken(caseId, userId)

  const resubmissionUrl = `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/onboarding-form/resubmit/${issued.token}`
  const subject = DOCUMENT_RESUBMISSION_EMAIL_SUBJECT
  const body = buildResubmissionEmailBody({
    merchantName: row.merchantName,
    ownerName: row.merchantOwnerName,
    rejections,
    resubmissionUrl,
  })

  return {
    recipient: recipient.email,
    // CC / BCC / reply-to from Configuration → Email sending, to add in
    // Gmail the same way the automatic email would.
    ...(await resolveCaseEmailRecipients({
      actorId: userId,
      merchant: {
        submitterEmail: row.merchantSubmitterEmail,
        businessEmail: row.merchantBusinessEmail,
      },
      recipient,
    })),
    subject,
    body,
    tokenId: issued.tokenId,
  }
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
    recipientEmailType?: EmailRecipientType
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  await validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'

  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      queueId: cases.queueId,
      currentStageId: cases.currentStageId,
      queueName: queues.name,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
      merchantWhatsappNumber: merchants.activeWhatsappNumber,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) throw new AppError(404, 'Case not found.')
  if (row.ownerId !== userId)
    throw new AppError(403, 'Only the case owner can confirm this.')
  await assertCanWorkCase(caseId, userId)
  if (
    row.status !== 'working' &&
    !(channel === 'whatsapp' && row.status === 'awaiting_client')
  )
    throw new AppError(400, 'The case must be in the working stage.')
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: row.merchantSubmitterEmail,
      businessEmail: row.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )
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
  if (!tokenRow) throw new AppError(400, 'Invalid preview token.')

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
  const rejectedFieldDetails = rejectedReviews.map((review) => ({
    fieldName: review.fieldName,
    label: getRejectionLabel(review.fieldName, documentTypeById),
    type: isDocumentFieldName(review.fieldName) ? 'document' : 'text',
    rejectionReason: review.remarks,
  }))

  const stages = await ensureQueueStages(db, {
    id: row.queueId,
    name: 'Documents Review',
    slug: row.queueSlug,
    qcEnabled: false,
    workflowType: row.workflowType ?? 'document_review',
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
    row.merchantId,
    row.merchantName,
    row.queueName,
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
          rejectedFieldDetails,
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
        rejectedFields: rejectedFieldNames,
        rejectedFieldLabels,
        rejectedFieldDetails,
        recipient:
          channel === 'whatsapp' ? row.merchantWhatsappNumber : recipient.email,
        emailRecipient: recipient.email,
        recipientEmailType: recipient.recipientEmailType,
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

export type AgreementEmailPreviewResult = ManualEmailRecipients & {
  recipient: string
  subject: string
  body: string
  tokenId: string
}

// Binds a manual confirmation to the exact email the agent previewed: any change
// to the recipient, remarks or Final Agreement makes the old preview invalid.
function buildAgreementPreviewToken(input: {
  caseId: string
  finalAgreementFileId: string
  recipient: string
  remarks: string | null
}) {
  return hashToken(
    [
      'agreement-email',
      input.caseId,
      input.finalAgreementFileId,
      input.recipient,
      input.remarks ?? '',
    ].join('\n'),
  )
}

export async function getAgreementEmailPreview(
  caseId: string,
  userId: string,
  input: {
    remarks?: string | null
    recipientEmailType?: EmailRecipientType
  } = {},
): Promise<AgreementEmailPreviewResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  const caseRow = await loadAgreementCase(caseId, userId)

  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  const details = await db.query.agreementCaseDetails.findFirst({
    where: eq(agreementCaseDetails.caseId, caseId),
  })
  if (!details?.finalAgreementFileId) {
    throw new AppError(400, 'Upload the Final Agreement before sending mail.')
  }

  const finalAgreement = await db.query.caseFiles.findFirst({
    where: eq(caseFiles.id, details.finalAgreementFileId),
  })
  if (!finalAgreement) {
    throw new AppError(400, 'The Final Agreement file could not be found.')
  }
  const merchantPortal = await getMerchantPortalSettings()
  const officeAddress = merchantPortal.officeAddress.trim()
  const legalEmail = merchantPortal.legalEmail.trim()
  if (!officeAddress) {
    throw new AppError(
      400,
      'Configure the office address before sending the Agreement email.',
    )
  }
  if (!legalEmail) {
    throw new AppError(
      400,
      'Configure the legal email before sending the Agreement email.',
    )
  }

  const remarks = input.remarks?.trim() || null
  const subject = agreementEmailSubject(caseRow.merchantName)
  const body = buildAgreementEmailBody({
    merchantName: caseRow.merchantName,
    ownerName: caseRow.merchantOwnerName,
    agreementUrl: finalAgreement.googleDriveWebViewLink,
    officeAddress,
    legalEmail,
    remarks,
  })

  return {
    recipient: recipient.email,
    // CC / BCC / reply-to from Configuration → Email sending, to add in
    // Gmail the same way the automatic email would.
    ...(await resolveCaseEmailRecipients({
      actorId: userId,
      merchant: {
        submitterEmail: caseRow.merchantSubmitterEmail,
        businessEmail: caseRow.merchantBusinessEmail,
      },
      recipient,
    })),
    subject,
    body,
    tokenId: await buildAgreementPreviewToken({
      caseId,
      finalAgreementFileId: details.finalAgreementFileId,
      recipient: recipient.email,
      remarks,
    }),
  }
}

export async function confirmAgreementEmailManual(
  caseId: string,
  userId: string,
  input: {
    remarks?: string | null
    tokenId: string
    file: File
    channel?: ManualCommunicationChannel
    recipientEmailType?: EmailRecipientType
  },
): Promise<ManualEmailResult> {
  await assertManualEmailEnabled()
  const db = getDb()
  await validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'

  const caseRow = await loadAgreementCase(caseId, userId)
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  const details = await db.query.agreementCaseDetails.findFirst({
    where: eq(agreementCaseDetails.caseId, caseId),
  })
  if (!details?.finalAgreementFileId) {
    throw new AppError(400, 'Upload the Final Agreement before confirming.')
  }

  const remarks = input.remarks?.trim() || null
  const expectedTokenId = await buildAgreementPreviewToken({
    caseId,
    finalAgreementFileId: details.finalAgreementFileId,
    recipient: recipient.email,
    remarks,
  })
  if (input.tokenId !== expectedTokenId) {
    throw new AppError(
      400,
      'The email preview is out of date. Load the preview again before confirming.',
    )
  }

  const awaitingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, 'awaiting_client'),
    ),
  })
  if (!awaitingStage)
    throw new AppError(500, 'No awaiting_client stage configured.')

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
    throw new AppError(409, 'This case has already been sent to the merchant.')

  const { savedFile } = await uploadEmailProofFile(
    caseId,
    userId,
    input.file,
    channel === 'whatsapp'
      ? AGREEMENT_WHATSAPP_PROOF_KIND
      : AGREEMENT_EMAIL_PROOF_KIND,
    caseRow.caseNumber,
    caseRow.merchantId,
    caseRow.merchantName,
    caseRow.queueName,
  )

  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(agreementCaseDetails)
      .set({
        emailStatus: 'sent',
        emailSentAt: now,
        emailRecipient: recipient.email,
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
        recipient: recipient.email,
        recipientEmailType: recipient.recipientEmailType,
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

export type MidCreationEmailPreviewResult = ManualEmailRecipients & {
  recipient: string
  subject: string
  body: string
  tokenId: string
}

export async function getMidCreationEmailPreview(
  caseId: string,
  userId: string,
  _input: SendMidCreationEmailInput,
): Promise<MidCreationEmailPreviewResult> {
  await assertManualEmailEnabled()
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
    _input.recipientEmailType,
  )

  const [limitsAndMdr, merchantPortal] = await Promise.all([
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])
  const subject = midCreationEmailSubject(caseRow.merchantName)
  const portalPassword = buildPortalPassword(
    credentials.email,
    caseRow.merchantNumber,
  )
  const payoutRateLabel = getClientPayoutRateLabel(credentials.merchantRole)
  const serverIntegration = resolveCustomWebsiteServerIntegration(
    caseRow.websiteCms,
    merchantPortal,
  )
  const body = buildMidCreationMessageBody({
    merchantName: caseRow.merchantName,
    portalEmail: credentials.email,
    portalPassword,
    merchantPortalUrl: merchantPortal.loginUrl,
    integrationGuideLabel: getMerchantIntegrationGuideLabel(caseRow.websiteCms),
    serverIntegration,
    paymentMethods: credentials.paymentMethods,
    payoutMethods: credentials.payoutMethods,
    testingLimits: limitsAndMdr.testing,
    payoutRate: `${limitsAndMdr.rates.payout}%`,
    payoutRateLabel,
  })

  return {
    recipient: recipient.email,
    // CC / BCC / reply-to from Configuration → Email sending, to add in
    // Gmail the same way the automatic email would.
    ...(await resolveCaseEmailRecipients({
      actorId: userId,
      merchant: {
        submitterEmail: caseRow.merchantSubmitterEmail,
        businessEmail: caseRow.merchantBusinessEmail,
      },
      recipient,
    })),
    subject,
    body,
    tokenId: caseId,
  }
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
  await validateEmailProofFile(input.file)
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
  await assertTestingLimitsAppliedForCredentials(credentials)
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

  if (input.tokenId !== caseId) {
    throw new AppError(400, 'Invalid preview token.')
  }

  const { savedFile } = await uploadEmailProofFile(
    caseId,
    userId,
    input.file,
    channel === 'whatsapp'
      ? MID_CREATION_WHATSAPP_PROOF_KIND
      : MID_CREATION_EMAIL_PROOF_KIND,
    caseRow.caseNumber,
    caseRow.merchantId,
    caseRow.merchantName,
    caseRow.queueName,
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
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      portalMid: credentials.portalMid,
      screenshotFileId: savedFile.id,
      channel,
      manual: true,
    },
    createdAt: now,
  })

  return { status: 'sent', fileId: savedFile.id }
}

export type LiveActivationEmailPreviewResult = ManualEmailRecipients & {
  recipient: string
  subject: string
  body: string
  tokenId: string
}

export async function getLiveActivationEmailPreview(
  caseId: string,
  userId: string,
  input: SendLiveEmailInput,
): Promise<LiveActivationEmailPreviewResult> {
  await assertManualEmailEnabled()
  const caseRow = await loadLiveCase(caseId, userId)
  const credentials = await getMidCreationCredentials(caseRow.merchantId)
  const [limitsAndMdr, merchantPortal] = await Promise.all([
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )
  const subject = liveActivationEmailSubject(caseRow.merchantName)

  return {
    recipient: recipient.email,
    // CC / BCC / reply-to from Configuration → Email sending, to add in
    // Gmail the same way the automatic email would.
    ...(await resolveCaseEmailRecipients({
      actorId: userId,
      merchant: {
        submitterEmail: caseRow.merchantSubmitterEmail,
        businessEmail: caseRow.merchantBusinessEmail,
      },
      recipient,
    })),
    subject,
    body: buildLiveActivationEmailBody({
      merchantName: caseRow.merchantName,
      merchantPortalUrl: merchantPortal.loginUrl,
      paymentMethods: credentials?.paymentMethods ?? [],
      payoutMethods: credentials?.payoutMethods ?? [],
      liveLimits: limitsAndMdr.live,
    }),
    tokenId: caseId,
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
  await validateEmailProofFile(input.file)
  const channel = input.channel ?? 'email'
  const caseRow = await loadLiveCase(caseId, userId)
  const recipient = resolveMerchantEmailRecipient(
    {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    input.recipientEmailType,
  )

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
    caseRow.merchantId,
    caseRow.merchantName,
    caseRow.queueName,
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
        recipient: recipient.email,
        recipientEmailType: recipient.recipientEmailType,
        screenshotFileId: savedFile.id,
        channel,
        manual: true,
      },
      createdAt: new Date(),
    })

  return { status: 'sent', fileId: savedFile.id }
}
