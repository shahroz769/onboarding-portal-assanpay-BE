import { lt, or, eq, and, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { env } from './config/env.js'
import { getDb } from './db/client.js'
import { refreshTokens } from './db/schema.js'
import { errorHandler } from './middleware/error-handler.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { caseRoutes } from './modules/cases/cases.routes.js'
import { configurationRoutes } from './modules/configuration/configuration.routes.js'
import { merchantFormRoutes } from './modules/merchants/form.routes.js'
import { merchantRoutes } from './modules/merchants/merchants.routes.js'
import { agreementUploadRoutes } from './modules/merchants/public-agreement.routes.js'
import { midGoLiveRoutes } from './modules/merchants/public-mid-go-live.routes.js'
import { resubmissionRoutes } from './modules/merchants/public-resubmission.routes.js'
import { notificationRoutes } from './modules/notifications/notifications.routes.js'
import { queueRoutes } from './modules/queues/queues.routes.js'
import { userRoutes } from './modules/users/users.routes.js'
import type { AppEnv } from './types/auth.js'

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

app.get('/health/db', async (c) => {
  const result = await getDb().execute(sql`select 1 as ok`)

  return c.json({
    status: 'ok',
    db: result[0]?.ok === 1,
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
