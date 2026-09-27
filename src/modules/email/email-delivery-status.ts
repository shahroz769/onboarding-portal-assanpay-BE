import { and, eq, inArray, or, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { caseHistory, cases, emailLog } from '../../db/schema'
import { publishCaseEmailStatus } from '../notifications/notifications.events'
import { notifyOnUndeliveredEmail } from '../notifications/notifications.service'
import { getEmailTemplateLabel } from './email-templates'

export type EmailDeliveryStatus = (typeof emailLog.$inferSelect)['status']

/** Statuses that mean the email will not reach the merchant. */
export const UNDELIVERED_EMAIL_STATUSES: ReadonlySet<EmailDeliveryStatus> =
  new Set(['bounced', 'complained', 'suppressed', 'failed'])

/** Statuses still waiting on Resend for an outcome. */
export const IN_FLIGHT_EMAIL_STATUSES: ReadonlySet<EmailDeliveryStatus> =
  new Set(['queued', 'sent', 'delivery_delayed'])

// Status updates (webhooks, status checks) can arrive late or out of order and
// are retried, so each status only replaces the statuses listed as its
// predecessors: a late `delivery_delayed` never overwrites `delivered`, and
// repeating an update changes nothing.
const ALL_STATUSES: EmailDeliveryStatus[] = [
  'queued',
  'sent',
  'delivery_delayed',
  'delivered',
  'bounced',
  'complained',
  'suppressed',
  'failed',
]
const IN_FLIGHT = [...IN_FLIGHT_EMAIL_STATUSES]

const REPLACES: Partial<Record<EmailDeliveryStatus, EmailDeliveryStatus[]>> = {
  sent: ['queued'],
  delivery_delayed: ['queued', 'sent'],
  delivered: IN_FLIGHT,
  failed: IN_FLIGHT,
  suppressed: IN_FLIGHT,
  // A bounce can follow a premature `delivered` (asynchronous bounces).
  bounced: [...IN_FLIGHT, 'delivered'],
  // Complaints come after delivery; they win over everything but themselves.
  complained: ALL_STATUSES.filter((status) => status !== 'complained'),
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Moves an email_log row to `status` if its current status allows it, then
 * tells the case owner's open pages and, for a failed delivery, records it on
 * the case and notifies the owner.
 *
 * The row is found by its id (the email_log_id tag Resend echoes back) or by
 * the Resend id, so an update that beats sendEmail storing the Resend id
 * still lands (and stores it).
 *
 * Returns 'unknown' when no row matches at all, 'unchanged' when the row
 * exists but the update is a repeat or out of order.
 */
export async function applyEmailDeliveryStatus(input: {
  resendId: string
  emailLogId?: string | null
  status: EmailDeliveryStatus
  detail: string | null
  occurredAt: Date
}): Promise<'updated' | 'unchanged' | 'unknown'> {
  const replaces = REPLACES[input.status]
  if (!replaces) return 'unchanged'

  const db = getDb()
  const emailLogId =
    input.emailLogId && UUID_PATTERN.test(input.emailLogId)
      ? input.emailLogId
      : null
  const matchesRow = emailLogId
    ? or(eq(emailLog.id, emailLogId), eq(emailLog.resendId, input.resendId))
    : eq(emailLog.resendId, input.resendId)

  const [updated] = await db
    .update(emailLog)
    .set({
      status: input.status,
      statusDetail: input.detail,
      statusUpdatedAt: Number.isNaN(input.occurredAt.getTime())
        ? new Date()
        : input.occurredAt,
      resendId: sql`coalesce(${emailLog.resendId}, ${input.resendId})`,
      updatedAt: new Date(),
    })
    .where(and(matchesRow, inArray(emailLog.status, replaces)))
    .returning({
      id: emailLog.id,
      caseId: emailLog.caseId,
      template: emailLog.template,
      toEmail: emailLog.toEmail,
      status: emailLog.status,
    })

  if (!updated) {
    const [existing] = await db
      .select({ id: emailLog.id })
      .from(emailLog)
      .where(matchesRow)
      .limit(1)
    return existing ? 'unchanged' : 'unknown'
  }

  if (!updated.caseId) return 'updated'

  const caseRow = await db.query.cases.findFirst({
    where: eq(cases.id, updated.caseId),
    columns: { ownerId: true, caseNumber: true },
  })

  if (UNDELIVERED_EMAIL_STATUSES.has(updated.status)) {
    await recordUndeliveredCaseEmail({
      caseId: updated.caseId,
      caseNumber: caseRow?.caseNumber ?? null,
      ownerId: caseRow?.ownerId ?? null,
      emailLogId: updated.id,
      template: updated.template,
      recipient: updated.toEmail,
      status: updated.status,
      detail: input.detail,
    })
  }

  // Refreshes the owner's open case page; bounces also arrive above as a
  // notification, which refreshes it too.
  if (caseRow?.ownerId) {
    publishCaseEmailStatus(caseRow.ownerId, {
      caseId: updated.caseId,
      emailLogId: updated.id,
      status: updated.status,
    })
  }

  return 'updated'
}

async function recordUndeliveredCaseEmail(input: {
  caseId: string
  caseNumber: string | null
  ownerId: string | null
  emailLogId: string
  template: string
  recipient: string
  status: EmailDeliveryStatus
  detail: string | null
}) {
  const templateLabel = getEmailTemplateLabel(input.template)

  await getDb()
    .insert(caseHistory)
    .values({
      caseId: input.caseId,
      actorId: null,
      action: 'email_undelivered',
      details: {
        emailLogId: input.emailLogId,
        template: input.template,
        templateLabel,
        recipient: input.recipient,
        status: input.status,
        detail: input.detail,
      },
    })

  if (input.ownerId && input.caseNumber) {
    await notifyOnUndeliveredEmail({
      caseId: input.caseId,
      caseNumber: input.caseNumber,
      ownerId: input.ownerId,
      templateLabel,
      recipient: input.recipient,
      status: input.status,
    })
  }
}
