import type { ReactElement } from 'react'
import { render } from '@react-email/render'
import { eq, sql } from 'drizzle-orm'

import { env } from '../../config/env'
import { getDb } from '../../db/client'
import { emailLog } from '../../db/schema'
import { getResendClient } from './email.client'

/**
 * Resend tag carrying the email_log id. Webhook events echo it back, so an
 * event can find its row even before the Resend id is stored below.
 */
export const EMAIL_LOG_ID_TAG = 'email_log_id'

export type SendEmailInput = {
  to: string
  cc?: string[]
  bcc?: string[]
  subject: string
  react: ReactElement
  template: string
  caseId?: string | null
  merchantId?: string | null
  idempotencyKey: string
  from?: string
  /** Where replies go; empty or omitted uses EMAIL_REPLY_TO. */
  replyTo?: string[]
  metadata?: Record<string, unknown>
}

export type SendEmailResult = {
  status: 'sent' | 'failed'
  resendId?: string
  emailLogId: string
  error?: string
  /** Who else the email went to, after the test inbox override. */
  cc: string[]
  bcc: string[]
  replyTo: string[]
}

/**
 * Render and send an email via Resend, recording the attempt in `email_log`.
 * Best-effort: never throws on provider errors. Returns `{status:"failed"}` instead.
 *
 * `sent` only means Resend accepted the email. Delivery (or a bounce) arrives
 * later through the Resend webhook, see resend-webhook.service.ts.
 */
export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const db = getDb()
  const fromAddress = input.from ?? env.EMAIL_FROM
  const replyTo =
    input.replyTo && input.replyTo.length > 0
      ? input.replyTo
      : env.EMAIL_REPLY_TO
        ? [env.EMAIL_REPLY_TO]
        : []
  const testRecipientOverride = env.EMAIL_TEST_TO
  const toAddress = testRecipientOverride ?? input.to
  // With the test inbox override only that inbox receives anything: CC and
  // BCC are dropped (and kept in metadata) so test sends never reach people.
  const cc = testRecipientOverride ? [] : (input.cc ?? [])
  const bcc = testRecipientOverride ? [] : (input.bcc ?? [])
  const recipients = { cc, bcc, replyTo }

  // 1. Pre-create the log row in `queued` state
  const [logRow] = await db
    .insert(emailLog)
    .values({
      toEmail: toAddress,
      ccEmails: cc,
      bccEmails: bcc,
      replyTo,
      subject: input.subject,
      template: input.template,
      caseId: input.caseId ?? null,
      merchantId: input.merchantId ?? null,
      status: 'queued',
      // Only emails sent while webhooks are configured receive delivery
      // events, so only those can gate a case (see case-email-delivery.ts).
      deliveryTracked: Boolean(env.RESEND_WEBHOOK_SECRET),
      metadata: testRecipientOverride
        ? {
            ...input.metadata,
            originalTo: input.to,
            originalCc: input.cc ?? [],
            originalBcc: input.bcc ?? [],
            overriddenTo: testRecipientOverride,
          }
        : (input.metadata ?? null),
    })
    .returning({ id: emailLog.id })

  const emailLogId = logRow!.id

  const markFailed = async (message: string) => {
    await db
      .update(emailLog)
      .set({
        status: 'failed',
        errorMsg: message,
        // Shown as the reason on the Failed badge.
        statusDetail: message,
        statusUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(emailLog.id, emailLogId))
    return {
      status: 'failed' as const,
      emailLogId,
      error: message,
      ...recipients,
    }
  }

  // 2. Render the React Email template to HTML
  let html: string
  try {
    html = await render(input.react)
  } catch (renderError) {
    const message =
      renderError instanceof Error ? renderError.message : String(renderError)
    return markFailed(`render: ${message}`)
  }

  // 3. Send via Resend (with idempotency)
  try {
    const result = await getResendClient().emails.send(
      {
        from: fromAddress,
        to: toAddress,
        ...(cc.length > 0 ? { cc } : {}),
        ...(bcc.length > 0 ? { bcc } : {}),
        subject: input.subject,
        html,
        ...(replyTo.length > 0 ? { replyTo } : {}),
        tags: [{ name: EMAIL_LOG_ID_TAG, value: emailLogId }],
      },
      { idempotencyKey: input.idempotencyKey },
    )

    if (result.error) {
      return markFailed(result.error.message ?? 'Unknown Resend error')
    }

    const resendId = result.data?.id
    // A webhook may already have moved the row on (e.g. to delivered) while
    // the send call was in flight; only a still-queued row becomes 'sent'.
    await db
      .update(emailLog)
      .set({
        status: sql`case when ${emailLog.status} = 'queued' then 'sent'::email_log_status else ${emailLog.status} end`,
        resendId: resendId ?? null,
        statusUpdatedAt: sql`case when ${emailLog.status} = 'queued' then now() else ${emailLog.statusUpdatedAt} end`,
        updatedAt: new Date(),
      })
      .where(eq(emailLog.id, emailLogId))

    return { status: 'sent', resendId, emailLogId, ...recipients }
  } catch (sendError) {
    return markFailed(
      sendError instanceof Error ? sendError.message : String(sendError),
    )
  }
}
