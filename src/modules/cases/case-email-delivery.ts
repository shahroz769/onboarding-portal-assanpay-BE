import { and, desc, eq, gt, isNotNull, like } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { caseHistory, cases, emailLog } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { getResendClient } from '../email/email.client'
import {
  applyEmailDeliveryStatus,
  IN_FLIGHT_EMAIL_STATUSES,
  UNDELIVERED_EMAIL_STATUSES,
} from '../email/email-delivery-status'
import type { EmailDeliveryStatus } from '../email/email-delivery-status'
import { getEmailTemplateLabel } from '../email/email-templates'

type Db = ReturnType<typeof getDb>
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

export type CaseEmailDelivery = {
  emailLogId: string
  template: string
  templateLabel: string
  recipient: string
  cc: string[]
  status: EmailDeliveryStatus
  /** Provider detail, e.g. the bounce reason. */
  detail: string | null
  sentAt: string
  statusUpdatedAt: string | null
  /** A later manual (Gmail) or WhatsApp send replaced this email. */
  supersededByManual: boolean
  /** Why the case can't be closed successfully yet, or null. */
  closeBlockedReason: string | null
}

/**
 * The case's latest email sent through Resend while delivery was tracked, and
 * whether it lets the case close. Emails sent before webhooks were set up
 * (delivery_tracked = false) never get delivery events, so they're ignored.
 */
export async function getCaseEmailDelivery(
  db: Db | DbTransaction,
  caseId: string,
): Promise<CaseEmailDelivery | null> {
  const latest = await findLatestTrackedEmail(db, caseId)
  if (!latest) return null

  const [[manualSend], [caseRow]] = await Promise.all([
    db
      .select({ id: caseHistory.id })
      .from(caseHistory)
      .where(
        and(
          eq(caseHistory.caseId, caseId),
          like(caseHistory.action, '%\\_sent\\_manual'),
          gt(caseHistory.createdAt, latest.createdAt),
        ),
      )
      .limit(1),
    db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1),
  ])

  const supersededByManual = Boolean(manualSend)
  const templateLabel = getEmailTemplateLabel(latest.template)

  return {
    emailLogId: latest.id,
    template: latest.template,
    templateLabel,
    recipient: latest.toEmail,
    cc: latest.ccEmails,
    status: latest.status,
    detail: latest.statusDetail,
    sentAt: latest.createdAt.toISOString(),
    statusUpdatedAt: latest.statusUpdatedAt?.toISOString() ?? null,
    supersededByManual,
    closeBlockedReason:
      supersededByManual || latest.status === 'delivered'
        ? null
        : closeBlockedReason({
            templateLabel,
            recipient: latest.toEmail,
            cc: latest.ccEmails,
            status: latest.status,
            awaitingMerchant: caseRow?.status === 'awaiting_merchant',
          }),
  }
}

async function findLatestTrackedEmail(db: Db | DbTransaction, caseId: string) {
  const [latest] = await db
    .select({
      id: emailLog.id,
      resendId: emailLog.resendId,
      template: emailLog.template,
      toEmail: emailLog.toEmail,
      ccEmails: emailLog.ccEmails,
      status: emailLog.status,
      statusDetail: emailLog.statusDetail,
      createdAt: emailLog.createdAt,
      statusUpdatedAt: emailLog.statusUpdatedAt,
    })
    .from(emailLog)
    .where(
      and(
        eq(emailLog.caseId, caseId),
        eq(emailLog.deliveryTracked, true),
        // Sends Resend rejected outright have no id; their workflow step was
        // already rolled back.
        isNotNull(emailLog.resendId),
      ),
    )
    .orderBy(desc(emailLog.createdAt))
    .limit(1)
  return latest ?? null
}

function closeBlockedReason(input: {
  templateLabel: string
  recipient: string
  cc: string[]
  status: EmailDeliveryStatus
  awaitingMerchant: boolean
}) {
  const email = `The ${input.templateLabel} email to ${input.recipient}`
  // Resending and manual sends need the case in Working.
  const fix = input.awaitingMerchant
    ? 'Move the case back to Working, then send it again to a working address or send it manually by Gmail or WhatsApp, before closing this case.'
    : 'Send it again to a working address, or send it manually by Gmail or WhatsApp, before closing this case.'
  // Resend reports one status for the whole email, so a CC'd address can be
  // the one that failed.
  const ccNote =
    input.cc.length > 0
      ? ` It was also copied to ${input.cc.join(', ')}, and any of these addresses may be the cause.`
      : ''

  switch (input.status) {
    case 'bounced':
      return `${email} bounced.${ccNote} ${fix}`
    case 'complained':
      return `${email} was marked as spam by a recipient.${ccNote} ${fix}`
    case 'suppressed':
      return `${email} was not delivered: an address is on the suppression list after an earlier bounce or complaint.${ccNote} ${fix}`
    case 'failed':
      return `${email} failed to send. ${fix}`
    case 'delivery_delayed':
      return `${email} is delayed. Resend keeps retrying for up to 72 hours. Wait for it, or ${
        input.awaitingMerchant
          ? 'move the case back to Working and send it manually by Gmail or WhatsApp.'
          : 'send it manually by Gmail or WhatsApp.'
      }`
    default:
      return `${email} hasn't been confirmed as delivered yet. This usually takes a few seconds; try again shortly.`
  }
}

/** Blocks closing a case successfully until its latest email is delivered. */
export async function assertCaseEmailDelivered(
  tx: DbTransaction,
  caseId: string,
) {
  const delivery = await getCaseEmailDelivery(tx, caseId)
  if (delivery?.closeBlockedReason) {
    throw new AppError(409, delivery.closeBlockedReason)
  }
}

// ─── Status check for a missing webhook ──────────────────────────────────────

/** How long an email may wait for a webhook before we ask Resend directly. */
const STATUS_CHECK_AFTER_MS = 2 * 60 * 1000
/** Minimum gap between checks of one email (in-process; see below). */
const STATUS_CHECK_INTERVAL_MS = 60 * 1000
const lastStatusCheckAt = new Map<string, number>()

// Resend's last_event for an email, as one of our statuses. Opens and clicks
// imply delivery; queued / scheduled mean there's nothing new yet.
const LAST_EVENT_STATUS: Record<string, EmailDeliveryStatus> = {
  sent: 'sent',
  delivery_delayed: 'delivery_delayed',
  delivered: 'delivered',
  opened: 'delivered',
  clicked: 'delivered',
  bounced: 'bounced',
  complained: 'complained',
  suppressed: 'suppressed',
  failed: 'failed',
  canceled: 'failed',
}

/**
 * When the case's latest email has waited over two minutes for a webhook
 * (a lost event, or the endpoint was down), asks Resend for its status and
 * applies it. Runs when the case is opened or closed, at most once a minute
 * per email. Best effort: a Resend error leaves the status as it was.
 *
 * The throttle is per process; with several instances each checks on its own,
 * which is still far below Resend's rate limit.
 */
export async function refreshStaleCaseEmailDelivery(caseId: string) {
  try {
    const latest = await findLatestTrackedEmail(getDb(), caseId)
    if (!latest?.resendId || !IN_FLIGHT_EMAIL_STATUSES.has(latest.status)) {
      return
    }
    const waitingSince = (latest.statusUpdatedAt ?? latest.createdAt).getTime()
    const now = Date.now()
    if (now - waitingSince < STATUS_CHECK_AFTER_MS) return
    if (now - (lastStatusCheckAt.get(latest.id) ?? 0) < STATUS_CHECK_INTERVAL_MS) {
      return
    }
    lastStatusCheckAt.set(latest.id, now)
    if (lastStatusCheckAt.size > 1000) {
      // Drop the oldest entries; only recent checks matter for the throttle.
      for (const key of [...lastStatusCheckAt.keys()].slice(0, 500)) {
        lastStatusCheckAt.delete(key)
      }
    }

    const { data, error } = await getResendClient().emails.get(latest.resendId)
    if (error || !data) {
      console.warn('[email-delivery] status check failed', error?.message)
      return
    }
    const status = LAST_EVENT_STATUS[data.last_event]
    if (!status || status === latest.status) return

    await applyEmailDeliveryStatus({
      resendId: latest.resendId,
      emailLogId: latest.id,
      status,
      detail:
        data.last_event === 'canceled'
          ? 'The email was canceled before it was sent.'
          : null,
      occurredAt: new Date(),
    })
  } catch (error) {
    console.warn('[email-delivery] status check failed', error)
  }
}
