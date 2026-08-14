import { lt, or, eq, and, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { rateLimiter } from 'hono-rate-limiter'

import { env } from './config/env'
import { closeQueryClient, getDb } from './db/client'
import { refreshTokens } from './db/schema'
import { errorHandler } from './middleware/error-handler'
import { getClientIp } from './lib/client-ip'
import { authRoutes } from './modules/auth/auth.routes'
import { caseRoutes } from './modules/cases/cases.routes'
import {
  getCaseFlowCloseJobHealth,
  processCaseFlowCloseJobs,
} from './modules/cases/case-flow.service'
import { configurationRoutes } from './modules/configuration/configuration.routes'
import { dashboardRoutes } from './modules/dashboard/dashboard.routes'
import { merchantFormRoutes } from './modules/merchants/form.routes'
import { merchantRoutes } from './modules/merchants/merchants.routes'
import { agreementUploadRoutes } from './modules/merchants/public-agreement.routes'
import { midGoLiveRoutes } from './modules/merchants/public-mid-go-live.routes'
import { resubmissionRoutes } from './modules/merchants/public-resubmission.routes'
import { notificationRoutes } from './modules/notifications/notifications.routes'
import { queueRoutes } from './modules/queues/queues.routes'
import { userRoutes } from './modules/users/users.routes'
import type { AppEnv } from './types/auth'

const app = new Hono<AppEnv>()

let caseFlowWorkerPromise: Promise<void> | null = null
let caseFlowWorkerLastCycleAt: Date | null = null
let caseFlowWorkerLastDurationMs: number | null = null
let caseFlowWorkerLastError: string | null = null

const publicRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-6',
  keyGenerator: getClientIp,
  handler: (c) =>
    c.json({ error: 'Too many public requests. Please try again later.' }, 429),
})

const publicMultipartLimit = bodyLimit({
  maxSize: 225 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Request body is too large.' }, 413),
})

const agreementMultipartLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Request body is too large.' }, 413),
})

app.use(
  '*',
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 86400,
  }),
)

app.onError(errorHandler)

app.use('/api/cases/*', async (c, next) => {
  const startedAt = performance.now()
  let outcome = 'success'

  try {
    await next()
  } catch (error) {
    outcome = 'error'
    throw error
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100
    if (c.req.method !== 'GET' || durationMs >= 250) {
      console.info(
        JSON.stringify({
          event: 'case_request_completed',
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          outcome,
          durationMs,
        }),
      )
    }
  }
})

app.use('/api/public/*', publicRateLimiter)
app.use('/api/public/merchant-form', publicMultipartLimit)
app.use('/api/public/resubmission/*', publicMultipartLimit)
app.use('/api/public/agreement/*', agreementMultipartLimit)

app.get('/', (c) => {
  return c.json({
    name: 'Onboarding Portal API',
    status: 'ok',
  })
})

app.get('/health/db', async (c) => {
  const [result, caseFlowJobs] = await Promise.all([
    getDb().execute(sql`select 1 as ok`),
    getCaseFlowCloseJobHealth(),
  ])

  return c.json({
    status: caseFlowJobs.failed > 0 ? 'degraded' : 'ok',
    db: result[0]?.ok === 1,
    caseFlowWorker: {
      running: caseFlowWorkerPromise !== null,
      lastCycleAt: caseFlowWorkerLastCycleAt,
      lastDurationMs: caseFlowWorkerLastDurationMs,
      lastCycleSucceeded: caseFlowWorkerLastError === null,
      ...caseFlowJobs,
    },
  })
})

app.route('/api/auth', authRoutes)
app.route('/api/public', merchantFormRoutes)
app.route('/api/public/resubmission', resubmissionRoutes)
app.route('/api/public/agreement', agreementUploadRoutes)
app.route('/api/public/mid-go-live', midGoLiveRoutes)
app.route('/api/merchants', merchantRoutes)
app.route('/api/users', userRoutes)
app.route('/api/queues', queueRoutes)
app.route('/api/cases', caseRoutes)
app.route('/api/configuration', configurationRoutes)
app.route('/api/dashboard', dashboardRoutes)
app.route('/api/notifications', notificationRoutes)

async function purgeExpiredRefreshTokens() {
  try {
    const result = await getDb()
      .delete(refreshTokens)
      .where(
        or(
          lt(refreshTokens.expiresAt, new Date()),
          and(
            eq(refreshTokens.status, 'revoked'),
            lt(
              refreshTokens.revokedAt,
              new Date(Date.now() - 24 * 60 * 60 * 1000),
            ),
          ),
          and(
            eq(refreshTokens.status, 'rotated'),
            lt(
              refreshTokens.revokedAt,
              new Date(Date.now() - 24 * 60 * 60 * 1000),
            ),
          ),
        ),
      )

    console.log(`[cleanup] Purged expired/revoked refresh tokens.`)
  } catch (error) {
    console.error('[cleanup] Failed to purge refresh tokens:', error)
  }
}

// Run cleanup immediately on startup, then every 6 hours
void purgeExpiredRefreshTokens()
const refreshTokenCleanupInterval = setInterval(
  () => void purgeExpiredRefreshTokens(),
  6 * 60 * 60 * 1000,
)

function drainCaseFlowCloseJobs() {
  if (caseFlowWorkerPromise) return caseFlowWorkerPromise

  const startedAt = performance.now()
  caseFlowWorkerPromise = (async () => {
    try {
      const result = await processCaseFlowCloseJobs(
        env.CASE_FLOW_WORKER_BATCH_SIZE,
      )
      caseFlowWorkerLastError = null

      if (result.completed > 0 || result.failed > 0) {
        console.info(
          JSON.stringify({
            event: 'case_flow_worker_cycle',
            ...result,
          }),
        )
      }
    } catch (error) {
      caseFlowWorkerLastError =
        error instanceof Error ? error.message : String(error)
      console.error('[case-flow] Worker cycle failed:', error)
    } finally {
      caseFlowWorkerLastCycleAt = new Date()
      caseFlowWorkerLastDurationMs =
        Math.round((performance.now() - startedAt) * 100) / 100
      caseFlowWorkerPromise = null
    }
  })()

  return caseFlowWorkerPromise
}

void drainCaseFlowCloseJobs()
const caseFlowWorkerInterval = setInterval(
  () => void drainCaseFlowCloseJobs(),
  env.CASE_FLOW_WORKER_POLL_MS,
)

let shuttingDown = false

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.info(`[shutdown] ${signal} received; draining background work.`)

  clearInterval(refreshTokenCleanupInterval)
  clearInterval(caseFlowWorkerInterval)

  const activeWorker = caseFlowWorkerPromise
  if (activeWorker) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      activeWorker,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 10_000)
      }),
    ])
    if (timeout) clearTimeout(timeout)
  }

  await closeQueryClient()
  process.exit(0)
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

export default {
  port: env.APP_PORT,
  fetch: app.fetch,
}
