import { Hono } from 'hono'

import { env } from '../../config/env'
import type { AppEnv } from '../../types/auth'
import { getResendClient } from './email.client'
import { handleResendWebhookEvent } from './resend-webhook.service'

// POST /api/webhooks/resend — Resend delivery events (delivered, bounced, …).
// Public, but every request must carry a valid Resend (Svix) signature for
// RESEND_WEBHOOK_SECRET; verification needs the raw, unparsed body.
export const resendWebhookRoutes = new Hono<AppEnv>()

resendWebhookRoutes.post('/', async (c) => {
  const webhookSecret = env.RESEND_WEBHOOK_SECRET
  if (!webhookSecret) {
    return c.json({ error: 'Resend webhooks are not configured.' }, 503)
  }

  const payload = await c.req.text()
  // Resend sends Svix signature headers; the standard webhook-* names are
  // accepted too.
  const header = (name: string) =>
    c.req.header(`svix-${name}`) ?? c.req.header(`webhook-${name}`) ?? ''
  let event
  try {
    event = getResendClient().webhooks.verify({
      payload,
      headers: {
        id: header('id'),
        timestamp: header('timestamp'),
        signature: header('signature'),
      },
      webhookSecret,
    })
  } catch {
    return c.json({ error: 'Invalid webhook signature.' }, 400)
  }

  // A thrown error returns 500, so Resend retries the event later.
  const outcome = await handleResendWebhookEvent(event)
  if (outcome === 'retry') {
    // The email isn't in email_log yet; Resend retries, by when it will be.
    return c.json({ error: 'Email not found yet; retry later.' }, 503)
  }
  return c.json({ received: true })
})
