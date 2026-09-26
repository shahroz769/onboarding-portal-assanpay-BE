import { eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { caseHistory, cases, merchants, queues, users } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { sendEmail } from '../email/email.service'
import { LiveActivationEmail } from '../email/templates/live-activation'
import {
  getLimitsAndMdrSettings,
  getMerchantPortalSettings,
} from '../configuration/configuration.service'
import type {
  MarkLiveLimitsAppliedInput,
  SendLiveEmailInput,
} from './cases.schemas'
import { assertCanWorkCase } from './case-access.service'
import { loadQueueStageForCase } from './case-transition.service'

import {
  getLiveLimitsAppliedEntry,
  getMidCreationCredentials,
} from './case-detail-lookups'
import {
  assertAutoEmailEnabled,
  resolveMerchantEmailRecipient,
} from './case-communication-helpers'
import type { MidCreationEmailResult } from './mid-case.service'

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

  if (caseRow.workflowType !== 'live') {
    throw new AppError(400, 'This action is only available for Live cases.')
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }
  await assertCanWorkCase(caseId, userId)

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await loadQueueStageForCase(db, caseRow.currentStageId, caseRow.queueId)
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

export async function loadLiveCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantSubmitterEmail: merchants.submitterEmail,
      merchantBusinessEmail: merchants.businessEmail,
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
  if (row.workflowType !== 'live') {
    throw new AppError(400, 'This action is only available for Live cases.')
  }
  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can send the live email.')
  }
  await assertCanWorkCase(caseId, userId)
  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function sendLiveActivationEmail(
  caseId: string,
  userId: string,
  input: SendLiveEmailInput,
): Promise<MidCreationEmailResult> {
  await assertAutoEmailEnabled()
  const db = getDb()
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

  const emailResult = await sendEmail({
    to: recipient.email,
    subject: `AssanPay account is live for ${caseRow.merchantName}`,
    template: 'live-activation',
    react: LiveActivationEmail({
      merchantName: caseRow.merchantName,
      merchantPortalUrl: merchantPortal.loginUrl,
      paymentMethods: credentials?.paymentMethods ?? [],
      payoutMethods: credentials?.payoutMethods ?? [],
      liveLimits: limitsAndMdr.live,
    }),
    caseId,
    merchantId: caseRow.merchantId,
    idempotencyKey: `live-activation/${caseId}`,
    metadata: {
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
      merchantPortalUrl: merchantPortal.loginUrl,
      liveLimits: limitsAndMdr.live,
      paymentMethods: credentials?.paymentMethods ?? [],
      payoutMethods: credentials?.payoutMethods ?? [],
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
      recipient: recipient.email,
      recipientEmailType: recipient.recipientEmailType,
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
