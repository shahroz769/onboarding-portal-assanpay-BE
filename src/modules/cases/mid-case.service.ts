import { eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { caseHistory, cases, merchants, queues } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { sendEmail } from '../email/email.service'
import { MidCreationEmail } from '../email/templates/mid-creation'
import {
  getLimitsAndMdrSettings,
  getMerchantPortalSettings,
} from '../configuration/configuration.service'
import type {
  SaveMidCreationDetailsInput,
  SendMidCreationEmailInput,
} from './cases.schemas'
import { assertCanWorkCase } from './case-access.service'
import { loadQueueStageForCase } from './case-transition.service'

import {
  assertTestingLimitsAppliedForCredentials,
  buildPortalPassword,
  getClientPayoutRateLabel,
  getMidCreationCredentials,
  getPayoutMethodsForMerchantRole,
} from './case-detail-lookups'
import {
  assertAutoEmailEnabled,
  getMerchantIntegrationGuideLabel,
  resolveCustomWebsiteServerIntegration,
  resolveCaseEmailRecipients,
  resolveMerchantEmailRecipient,
} from './case-communication-helpers'

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
  await assertCanWorkCase(caseId, userId)

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await loadQueueStageForCase(db, caseRow.currentStageId, caseRow.queueId)
    : null

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(400, 'MID details can only be saved in working.')
  }

  const configuredPayoutMethods = await getPayoutMethodsForMerchantRole(
    input.merchantRole,
  )
  const payoutMethods = configuredPayoutMethods.map((method) => {
    const submittedMethod = input.payoutMethods.find(
      (submitted) => submitted.id === method.id,
    )
    return submittedMethod
      ? { ...method, commissionRate: submittedMethod.commissionRate }
      : method
  })
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
  await assertCanWorkCase(caseId, userId)
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
  // Resolved before the case changes state, so a lookup failure leaves it
  // untouched.
  const extraRecipients = await resolveCaseEmailRecipients({
    actorId: userId,
    merchant: {
      submitterEmail: caseRow.merchantSubmitterEmail,
      businessEmail: caseRow.merchantBusinessEmail,
    },
    recipient,
  })

  const [limitsAndMdr, merchantPortal] = await Promise.all([
    getLimitsAndMdrSettings(),
    getMerchantPortalSettings(),
  ])
  const portalPassword = buildPortalPassword(
    credentials.email,
    caseRow.merchantNumber,
  )
  const payoutRateLabel = getClientPayoutRateLabel(credentials.merchantRole)
  const serverIntegration = resolveCustomWebsiteServerIntegration(
    caseRow.websiteCms,
    merchantPortal,
  )
  const communicationId = crypto.randomUUID()

  const emailResult = await sendEmail({
    to: recipient.email,
    ...extraRecipients,
    subject: `AssanPay merchant portal credentials for ${caseRow.merchantName}`,
    template: 'mid-creation',
    react: MidCreationEmail({
      merchantName: caseRow.merchantName,
      portalEmail: credentials.email,
      portalPassword,
      merchantPortalUrl: merchantPortal.loginUrl,
      integrationGuideLabel: getMerchantIntegrationGuideLabel(
        caseRow.websiteCms,
      ),
      serverIntegration,
      paymentMethods: credentials.paymentMethods,
      payoutMethods: credentials.payoutMethods,
      testingLimits: limitsAndMdr.testing,
      rates: {
        payout: limitsAndMdr.rates.payout,
        payoutLabel: payoutRateLabel,
      },
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `mid-creation/${caseId}/${communicationId}`,
    metadata: {
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      portalEmail: credentials.email,
      portalMid: credentials.portalMid,
      websiteCms: caseRow.websiteCms,
      paymentMethods: credentials.paymentMethods,
      payoutMethods: credentials.payoutMethods,
      limitsAndMdr,
      merchantPortalUrl: merchantPortal.loginUrl,
      serverIntegration,
    },
  })

  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action:
      emailResult.status === 'sent'
        ? 'mid_creation_email_sent'
        : 'mid_creation_email_failed',
    details: {
      emailLogId: emailResult.emailLogId,
      recipient: recipient.email,
      cc: emailResult.cc,
      bcc: emailResult.bcc,
      replyTo: emailResult.replyTo,
      recipientEmailType: recipient.recipientEmailType,
      portalMid: credentials.portalMid,
      error: emailResult.error ?? null,
    },
  })

  if (emailResult.status === 'failed') {
    return {
      status: 'failed',
      emailLogId: emailResult.emailLogId,
      error: emailResult.error,
    }
  }

  return {
    status: 'sent',
    emailLogId: emailResult.emailLogId,
  }
}
