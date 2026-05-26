import { lt, or, eq, and, sql } from 'drizzle-orm'
import { env } from './config/env.js'
import { app } from './app.js'
import { getDb } from './db/client.js'
import { refreshTokens } from './db/schema.js'

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
