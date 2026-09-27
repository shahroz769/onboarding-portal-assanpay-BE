import type { WebhookEventPayload } from 'resend'

import { applyEmailDeliveryStatus } from './email-delivery-status'
import type { EmailDeliveryStatus } from './email-delivery-status'
import { EMAIL_LOG_ID_TAG } from './email.service'

// Resend webhook events that move an email_log row past 'sent'. The ordering
// rules (late or repeated events) live in email-delivery-status.ts.
const EVENT_STATUS: Partial<
  Record<WebhookEventPayload['type'], EmailDeliveryStatus>
> = {
  'email.sent': 'sent',
  'email.delivery_delayed': 'delivery_delayed',
  'email.delivered': 'delivered',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
}

/** Unknown emails younger than this get a retry (see the route). */
const UNKNOWN_EMAIL_RETRY_WINDOW_MS = 10 * 60 * 1000

function describeEvent(event: WebhookEventPayload): string | null {
  switch (event.type) {
    case 'email.bounced': {
      const { type, subType, message } = event.data.bounce
      return [type, subType].filter(Boolean).join(' / ') + `: ${message}`
    }
    case 'email.failed':
      return event.data.failed.reason
    case 'email.suppressed':
      return event.data.suppressed.message
    default:
      return null
  }
}

/**
 * Applies a verified Resend webhook event. Returns 'retry' when the email
 * isn't known yet but the event is recent: the route answers 503 so Resend
 * sends it again rather than the update being lost. Older unknown emails
 * (sent by something else on the account) are acknowledged and ignored.
 */
export async function handleResendWebhookEvent(
  event: WebhookEventPayload,
): Promise<'ok' | 'retry'> {
  const status = EVENT_STATUS[event.type]
  if (!status || !('email_id' in event.data)) return 'ok'

  const occurredAt = new Date(event.created_at)
  const result = await applyEmailDeliveryStatus({
    resendId: event.data.email_id,
    emailLogId:
      'tags' in event.data ? (event.data.tags?.[EMAIL_LOG_ID_TAG] ?? null) : null,
    status,
    detail: describeEvent(event),
    occurredAt,
  })

  const isRecent =
    Number.isNaN(occurredAt.getTime()) ||
    Date.now() - occurredAt.getTime() < UNKNOWN_EMAIL_RETRY_WINDOW_MS
  return result === 'unknown' && isRecent ? 'retry' : 'ok'
}
