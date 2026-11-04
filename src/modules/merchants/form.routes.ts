import { Hono } from 'hono'

import { getClientIp } from '../../lib/client-ip'
import { AppError } from '../../lib/errors'
import type { AppEnv } from '../../types/auth'
import { parseMerchantFormData } from './merchants.schemas'
import {
  createMerchantSubmission,
  isExistingSubmissionKey,
} from './merchants.service'
import {
  assertSubmissionQuota,
  recordSubmissionAttempt,
  type SubmissionClient,
} from './submission-attempts.service'

export const merchantFormRoutes = new Hono<AppEnv>()

// The form sends a random UUID; allow any similar opaque token.
const submissionKeyPattern = /^[A-Za-z0-9_-]{16,128}$/

async function recordFailedAttempt(client: SubmissionClient, error: unknown) {
  if (error instanceof AppError) {
    await recordSubmissionAttempt({
      client,
      outcome: error.statusCode === 429 ? 'rate_limited' : 'rejected',
      statusCode: error.statusCode,
      errorMessage: error.message,
    })
    return
  }

  await recordSubmissionAttempt({
    client,
    outcome: 'error',
    statusCode: 500,
    errorMessage: 'Unexpected server error.',
  })
}

merchantFormRoutes.post('/merchant-form', async (c) => {
  const client: SubmissionClient = {
    ipAddress: getClientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
  }

  try {
    const contentType = c.req.header('content-type') ?? ''

    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw new AppError(400, 'Content-Type must be multipart/form-data.')
    }

    // Optional until every open form sends it; older pages submit without one.
    const submissionKey = c.req.header('idempotency-key') ?? null
    if (submissionKey !== null && !submissionKeyPattern.test(submissionKey)) {
      throw new AppError(400, 'Idempotency-Key header is invalid.')
    }

    // Before the upload is read, so an over-limit client costs almost nothing.
    // A retry of an accepted submission must still get its merchant back.
    if (!(submissionKey && (await isExistingSubmissionKey(submissionKey)))) {
      await assertSubmissionQuota(client.ipAddress)
    }

    const formData = await c.req.formData().catch(() => {
      throw new AppError(400, 'Invalid multipart form payload.')
    })
    const input = await parseMerchantFormData(formData)
    const result = await createMerchantSubmission(input, {
      submissionKey,
      client,
    })

    if (result.replayed) {
      await recordSubmissionAttempt({
        client,
        outcome: 'replayed',
        statusCode: 200,
        merchantId: result.merchant.id,
      })
    }

    return c.json(
      {
        merchant: result.merchant,
        documents: result.documents,
      },
      result.replayed ? 200 : 201,
    )
  } catch (error) {
    await recordFailedAttempt(client, error)
    throw error
  }
})
