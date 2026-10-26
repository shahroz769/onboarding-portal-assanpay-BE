import { Hono } from 'hono'

import { AppError } from '../../lib/errors'
import type { AppEnv } from '../../types/auth'
import { parseMerchantFormData } from './merchants.schemas'
import { createMerchantSubmission } from './merchants.service'

export const merchantFormRoutes = new Hono<AppEnv>()

// The form sends a random UUID; allow any similar opaque token.
const submissionKeyPattern = /^[A-Za-z0-9_-]{16,128}$/

merchantFormRoutes.post('/merchant-form', async (c) => {
  const contentType = c.req.header('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }

  // Optional until every open form sends it; older pages submit without one.
  const submissionKey = c.req.header('idempotency-key') ?? null
  if (submissionKey !== null && !submissionKeyPattern.test(submissionKey)) {
    throw new AppError(400, 'Idempotency-Key header is invalid.')
  }

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const input = await parseMerchantFormData(formData)
  const result = await createMerchantSubmission(input, { submissionKey })

  return c.json(
    {
      merchant: result.merchant,
      documents: result.documents,
    },
    result.replayed ? 200 : 201,
  )
})
