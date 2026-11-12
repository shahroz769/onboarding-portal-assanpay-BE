import { and, eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'

import { getDb } from '../db/client'
import { users } from '../db/schema'
import { verifyAccessToken } from '../lib/auth'
import { AppError } from '../lib/errors'
import type { AppEnv, SessionUser } from '../types/auth'

/**
 * The session behind an access token, or null when the token is invalid or
 * expired, the user is inactive, or the session was revoked (sessionVersion
 * bumped by a password set, deactivation, role/access change or sign-out
 * everywhere).
 */
export async function resolveCurrentSession(
  token: string,
): Promise<SessionUser | null> {
  const session = await verifyAccessToken(token).catch(() => null)
  if (!session) return null

  const user = await getDb().query.users.findFirst({
    columns: { id: true },
    where: and(
      eq(users.id, session.userId),
      eq(users.status, 'active'),
      eq(users.sessionVersion, session.sessionVersion),
    ),
  })

  return user ? session : null
}

export function getBearerToken(authorization: string | undefined) {
  if (!authorization?.startsWith('Bearer ')) return null
  return authorization.slice('Bearer '.length).trim() || null
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getBearerToken(c.req.header('authorization'))

  if (!token) {
    throw new AppError(401, 'Missing bearer token.')
  }

  const session = await verifyAccessToken(token).catch(() => {
    throw new AppError(401, 'Invalid access token.')
  })

  const user = await getDb().query.users.findFirst({
    columns: { id: true },
    where: and(
      eq(users.id, session.userId),
      eq(users.status, 'active'),
      eq(users.sessionVersion, session.sessionVersion),
    ),
  })

  if (!user) {
    throw new AppError(401, 'Access token is expired or revoked.')
  }

  c.set('auth', session)

  await next()
})
