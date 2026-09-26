import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'

import { AppError } from '../lib/errors'
import type { AppEnv } from '../types/auth'

// Unique constraints valid input can hit. Anything not listed still maps to a
// generic 409 so a conflict is never reported as a server failure.
const uniqueViolationMessages: Record<string, string> = {
  queues_name_unique: 'A queue with this name already exists.',
  queues_slug_unique: 'A queue with this slug already exists.',
  queues_prefix_unique: 'A queue with this prefix already exists.',
  queue_stages_queue_slug_uniq:
    'A stage with this slug already exists in the queue.',
  users_email_unique: 'A user with this email already exists.',
  users_username_unique: 'A user with this username already exists.',
  sub_merchant_draft_templates_name_unique:
    'A sub-merchant with this name already exists.',
  sub_merchant_draft_templates_seller_code_uniq:
    'A sub-merchant with this Seller Code already exists.',
}

function getDatabaseError(error: Error) {
  const databaseError = error.cause ?? error
  if (
    databaseError &&
    typeof databaseError === 'object' &&
    'code' in databaseError &&
    typeof databaseError.code === 'string'
  ) {
    return databaseError as { code: string; constraint_name?: string }
  }
  return null
}

export function errorHandler(error: Error, c: Context<AppEnv>) {
  if (error instanceof AppError) {
    return c.json(
      { error: error.message, ...(error.details ?? {}) },
      error.statusCode as ContentfulStatusCode,
    )
  }

  // Hono's own middleware and validators throw HTTPException with the intended
  // status and a client-safe message; keep both instead of reporting a server
  // error. An exception thrown with a custom response is returned as-is.
  if (error instanceof HTTPException) {
    if (error.res) return error.getResponse()
    return c.json({ error: error.message || 'Request failed.' }, error.status)
  }

  // Service-level schema.parse() calls reject client input.
  if (error instanceof ZodError) {
    return c.json(
      { error: error.issues[0]?.message ?? 'Invalid request payload.' },
      400,
    )
  }

  // Only translate known database codes; never expose arbitrary SQL errors.
  const databaseError = getDatabaseError(error)
  if (databaseError?.code === 'P7501') {
    return c.json(
      {
        error:
          'This queue or its stages are required by a published flow. Use a new queue for incompatible changes, or wait until the old flow has finished and remove the queue from the current flow.',
      },
      409,
    )
  }

  if (databaseError?.code === '23505') {
    return c.json(
      {
        error:
          uniqueViolationMessages[databaseError.constraint_name ?? ''] ??
          'This record conflicts with an existing one.',
      },
      409,
    )
  }

  // invalid_text_representation: a malformed id or enum value reached a query.
  if (databaseError?.code === '22P02') {
    return c.json({ error: 'Invalid identifier or value.' }, 400)
  }

  console.error(`[request ${c.get('requestId')}]`, error)
  return c.json({ error: 'Internal server error.' }, 500)
}
