import { lt, or, eq, and, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

import { env } from './config/env'
import { getDb } from './db/client'
import { refreshTokens } from './db/schema'
import { errorHandler } from './middleware/error-handler'
import { authRoutes } from './modules/auth/auth.routes'
import { caseRoutes } from './modules/cases/cases.routes'
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

app.get('/', (c) => {
  return c.json({
    name: 'Onboarding Portal API',
    status: 'ok',
  })
})

async function databaseReadiness(c: Context<AppEnv>) {
  try {
    const result = await getDb().execute(sql`select 1 as ok`)
    const ready = result[0]?.ok === 1

    return c.json(
      { status: ready ? 'ok' : 'unavailable', db: ready },
      ready ? 200 : 503,
    )
  } catch (error) {
    console.error('[health] Database readiness check failed:', error)
    return c.json({ status: 'unavailable', db: false }, 503)
  }
}

app.get('/health/ready', databaseReadiness)
app.get('/health/db', databaseReadiness)

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
purgeExpiredRefreshTokens()
setInterval(purgeExpiredRefreshTokens, 6 * 60 * 60 * 1000)

export default {
  port: env.APP_PORT,
  fetch: app.fetch,
}
