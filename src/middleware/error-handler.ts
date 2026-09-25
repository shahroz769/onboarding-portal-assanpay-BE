import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { AppError } from '../lib/errors'

export function errorHandler(error: Error, c: Context) {
  if (error instanceof AppError) {
    return c.json(
      { error: error.message, ...(error.details ?? {}) },
      error.statusCode as never,
    )
  }

  // Hono's own middleware (e.g. csrf) throws HTTPException with the intended
  // status; keep it instead of reporting a server error.
  if (error instanceof HTTPException) {
    return c.json(
      { error: error.status === 403 ? 'Forbidden.' : 'Request failed.' },
      error.status,
    )
  }

  // Only translate our explicit database guard; never expose arbitrary SQL errors.
  const databaseError = error.cause ?? error
  if (
    databaseError &&
    typeof databaseError === 'object' &&
    'code' in databaseError &&
    databaseError.code === 'P7501'
  ) {
    return c.json(
      {
        error:
          'This queue or its stages are required by a published flow. Use a new queue for incompatible changes, or wait until the old flow has finished and remove the queue from the current flow.',
      },
      409,
    )
  }

  console.error(error)
  return c.json({ error: 'Internal server error.' }, 500)
}
