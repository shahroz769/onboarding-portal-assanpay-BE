import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { rateLimiter } from 'hono-rate-limiter'

import { env } from '../../config/env'
import { getClientIp } from '../../lib/client-ip'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  loginSchema,
  passwordTokenParamSchema,
  registerSuperAdminSchema,
  setPasswordSchema,
} from './auth.schemas'
import {
  getLoginAccountKey,
  getPasswordTokenContext,
  login,
  logout,
  refreshSession,
  registerSuperAdmin,
  setPasswordWithToken,
} from './auth.service'

const REFRESH_COOKIE_NAME = 'refresh_token'
const cookieSameSite = {
  lax: 'Lax',
  strict: 'Strict',
  none: 'None',
} as const

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: cookieSameSite[env.COOKIE_SAME_SITE],
    secure: env.COOKIE_SECURE,
    path: '/',
    domain: env.COOKIE_DOMAIN,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  }
}

// Counts failed attempts only: users behind one shared IP (an office NAT)
// must not use up each other's budget by signing in normally.
const authRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-6',
  skipSuccessfulRequests: true,
  keyGenerator: getClientIp,
  handler: (c) =>
    c.json({ error: 'Too many attempts. Please try again later.' }, 429),
})

// Per-account guard against password guessing spread across many IPs. Only
// failed attempts count, so a user who signs in normally is never limited.
const loginAccountRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const account =
      body && typeof body === 'object'
        ? ('identifier' in body && body.identifier) ||
          ('email' in body && body.email)
        : null
    return typeof account === 'string' && account.trim()
      ? getLoginAccountKey(account.trim())
      : `ip:${getClientIp(c)}`
  },
  handler: (c) =>
    c.json(
      { error: 'Too many failed sign-in attempts. Please try again later.' },
      429,
    ),
})

export const authRoutes = new Hono<AppEnv>()

authRoutes.use('/login', csrf({ origin: env.CORS_ORIGIN }))
authRoutes.use('/refresh', csrf({ origin: env.CORS_ORIGIN }))
authRoutes.use('/logout', csrf({ origin: env.CORS_ORIGIN }))

authRoutes.use('/login', authRateLimiter)
authRoutes.use('/login', loginAccountRateLimiter)
authRoutes.use('/register-super-admin', authRateLimiter)

authRoutes.post(
  '/register-super-admin',
  zodValidator('json', registerSuperAdminSchema),
  async (c) => {
    if (!env.ALLOW_SUPER_ADMIN_REGISTRATION) {
      return c.json({ error: 'Super Admin registration is disabled.' }, 403)
    }

    const input = c.req.valid('json')
    const user = await registerSuperAdmin(input)

    return c.json({ user }, 201)
  },
)

authRoutes.post('/login', zodValidator('json', loginSchema), async (c) => {
  const input = c.req.valid('json')
  const session = await login({
    ...input,
    userAgent: c.req.header('user-agent'),
    ipAddress: getClientIp(c),
  })

  const cookieOptions = getCookieOptions()
  setCookie(c, REFRESH_COOKIE_NAME, session.refreshToken, cookieOptions)

  return c.json({
    accessToken: session.accessToken,
    user: session.user,
  })
})

authRoutes.post('/refresh', async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE_NAME)

  if (!refreshToken) {
    return c.json({ error: 'Missing refresh token.' }, 401)
  }

  const session = await refreshSession({
    refreshToken,
    userAgent: c.req.header('user-agent'),
    ipAddress: getClientIp(c),
  })

  const cookieOptions = getCookieOptions()
  setCookie(c, REFRESH_COOKIE_NAME, session.refreshToken, cookieOptions)

  return c.json({
    accessToken: session.accessToken,
    user: session.user,
  })
})

authRoutes.post('/logout', async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE_NAME)

  if (refreshToken) {
    await logout(refreshToken)
  }

  deleteCookie(c, REFRESH_COOKIE_NAME, getCookieOptions())

  return c.json({ success: true })
})

authRoutes.get(
  '/password-token/:token',
  zodValidator('param', passwordTokenParamSchema),
  async (c) => {
    const { token } = c.req.valid('param')
    const context = await getPasswordTokenContext(token)
    return c.json(context)
  },
)

authRoutes.post(
  '/set-password',
  zodValidator('json', setPasswordSchema),
  async (c) => {
    const input = c.req.valid('json')
    const user = await setPasswordWithToken(input)
    return c.json({ user })
  },
)
