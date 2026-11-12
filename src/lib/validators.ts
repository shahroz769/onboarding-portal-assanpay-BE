import type { ValidationTargets } from 'hono'
import { validator } from 'hono/validator'
import * as z from 'zod'

import { AppError } from './errors'

export function zodValidator<
  TTarget extends keyof ValidationTargets,
  TSchema extends z.ZodType,
>(target: TTarget, schema: TSchema) {
  return validator(target, (value) => {
    const parsed = schema.safeParse(value)

    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message ?? `Invalid ${target} payload.`,
      )
    }

    return parsed.data
  })
}

/**
 * An absolute http or https URL. Plain z.url() also accepts schemes such as
 * javascript: or data:, which become live links where the value is shown.
 */
export function webUrlSchema(message = 'Enter a valid http or https URL.') {
  return z.url({ protocol: /^https?$/, error: message })
}
