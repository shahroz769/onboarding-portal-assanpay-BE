import { inArray, lt, sql } from 'drizzle-orm'

import { env } from '../../config/env'
import { getDb } from '../../db/client'
import { loginAttemptCounters } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { hashToken } from '../../lib/security'

/**
 * Sign-in throttling that a third party cannot turn against the account
 * holder (OWASP "device cookies").
 *
 * - A browser the user chose to trust at sign-in carries a signed device
 *   cookie. Its attempts count on a budget of its own.
 * - Any other browser counts per account + IP, and on a shared account-wide
 *   budget. Exhausting that only pauses sign-in from untrusted browsers; a
 *   trusted one still gets in.
 *
 * Every limit is a fixed one-hour window and lifts on its own. A successful
 * sign-in clears the counters it used.
 */

export const DEVICE_COOKIE_NAME = 'login_device'
// Keep in step with the interval in windowExpired below.
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000
const DEVICE_ATTEMPT_LIMIT = 5
const ACCOUNT_IP_ATTEMPT_LIMIT = 5
const ACCOUNT_ATTEMPT_LIMIT = 15

const DEVICE_COOKIE_VERSION = 'v1'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Device cookie ──────────────────────────────────────────────────────────

let deviceKey: Promise<CryptoKey> | undefined

// A key of its own, derived from the refresh secret, so a device cookie can
// never be confused with a JWT and no new secret has to be deployed.
function getDeviceKey() {
  deviceKey ??= crypto.subtle
    .importKey(
      'raw',
      new TextEncoder().encode(env.JWT_REFRESH_SECRET),
      'HKDF',
      false,
      ['deriveKey'],
    )
    .then((baseKey) =>
      crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(0),
          info: new TextEncoder().encode('login-device-cookie-v1'),
        },
        baseKey,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      ),
    )
  return deviceKey
}

// The signature also covers the user's sessionVersion, so a password change,
// deactivation or "sign out everywhere" stops trusting every device at once.
function devicePayload(input: {
  userId: string
  deviceId: string
  expiresAt: number
  sessionVersion: number
}) {
  return new TextEncoder().encode(
    [
      DEVICE_COOKIE_VERSION,
      input.userId,
      input.deviceId,
      input.expiresAt,
      input.sessionVersion,
    ].join('.'),
  )
}

export function getDeviceCookieMaxAgeSeconds() {
  return env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60
}

/** Cookie value: v1.<userId>.<deviceId>.<expiresAt seconds>.<signature>. */
export async function issueDeviceCookie(input: {
  userId: string
  sessionVersion: number
  deviceId?: string
}) {
  const deviceId = input.deviceId ?? crypto.randomUUID()
  const expiresAt =
    Math.floor(Date.now() / 1000) + getDeviceCookieMaxAgeSeconds()
  const signature = await crypto.subtle.sign(
    'HMAC',
    await getDeviceKey(),
    devicePayload({ ...input, deviceId, expiresAt }),
  )

  return [
    DEVICE_COOKIE_VERSION,
    input.userId,
    deviceId,
    expiresAt,
    Buffer.from(signature).toString('base64url'),
  ].join('.')
}

/** The device id when the cookie is valid for this user, otherwise null. */
export async function getTrustedDeviceId(
  cookie: string | undefined,
  user: { id: string; sessionVersion: number },
) {
  if (!cookie) return null

  const parts = cookie.split('.')
  if (parts.length !== 5) return null

  const [version, userId, deviceId, expiresAtText, signatureText] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (version !== DEVICE_COOKIE_VERSION || userId !== user.id) return null
  if (!UUID_PATTERN.test(deviceId) || !/^\d{1,12}$/.test(expiresAtText)) {
    return null
  }

  const expiresAt = Number(expiresAtText)
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null

  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await getDeviceKey(),
    Buffer.from(signatureText, 'base64url'),
    devicePayload({
      userId,
      deviceId,
      expiresAt,
      sessionVersion: user.sessionVersion,
    }),
  )

  return valid ? deviceId : null
}

// ─── Attempt counters ───────────────────────────────────────────────────────

type AttemptBudget = {
  key: string
  limit: number
  message: (minutes: number) => string
}

function retryMessage(prefix: string) {
  return (minutes: number) =>
    `${prefix} Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

/**
 * The budgets one sign-in attempt draws on. `account` is the user id when the
 * identifier matches a user, else the typed identifier, so unknown accounts
 * are throttled the same way and the limits do not reveal which exist.
 */
export function getAttemptBudgets(
  input:
    | { trusted: true; userId: string; deviceId: string }
    | { trusted: false; account: string; ip: string },
): AttemptBudget[] {
  if (input.trusted) {
    return [
      {
        key: `device:${input.userId}:${input.deviceId}`,
        limit: DEVICE_ATTEMPT_LIMIT,
        message: retryMessage('Too many failed sign-in attempts.'),
      },
    ]
  }

  return [
    {
      key: `account_ip:${input.account}:${input.ip}`,
      limit: ACCOUNT_IP_ATTEMPT_LIMIT,
      message: retryMessage('Too many failed sign-in attempts.'),
    },
    {
      key: `account:${input.account}`,
      limit: ACCOUNT_ATTEMPT_LIMIT,
      message: retryMessage(
        'Too many failed sign-in attempts on this account. Sign-in from new devices is paused; a device you chose to trust can still sign in.',
      ),
    },
  ]
}

/** The account-wide key, cleared by any successful sign-in to the account. */
export function getAccountAttemptKey(account: string) {
  return `account:${account}`
}

const windowExpired = sql`${loginAttemptCounters.windowStartedAt} <= now() - interval '1 hour'`

/**
 * Counts this attempt before the password is checked, so concurrent requests
 * cannot slip past a limit and a blocked request never confirms a guess. A
 * successful sign-in clears the counters again.
 */
export async function reserveAttempts(budgets: AttemptBudget[]) {
  for (const budget of budgets) {
    const [row] = await getDb()
      .insert(loginAttemptCounters)
      .values({
        keyHash: await hashToken(budget.key),
        attempts: 1,
        windowStartedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: loginAttemptCounters.keyHash,
        set: {
          attempts: sql`case when ${windowExpired} then 1 else ${loginAttemptCounters.attempts} + 1 end`,
          windowStartedAt: sql`case when ${windowExpired} then now() else ${loginAttemptCounters.windowStartedAt} end`,
        },
      })
      .returning({
        attempts: loginAttemptCounters.attempts,
        windowStartedAt: loginAttemptCounters.windowStartedAt,
      })

    if (row && row.attempts > budget.limit) {
      const retryAfterMs =
        row.windowStartedAt.getTime() + ATTEMPT_WINDOW_MS - Date.now()
      throw new AppError(
        429,
        budget.message(Math.max(1, Math.ceil(retryAfterMs / 60_000))),
      )
    }
  }

  // An expired window is only ever reused by its own key; sweep the others
  // now and then so the table stays small.
  if (Math.random() < 0.02) {
    await getDb()
      .delete(loginAttemptCounters)
      .where(
        lt(
          loginAttemptCounters.windowStartedAt,
          new Date(Date.now() - ATTEMPT_WINDOW_MS),
        ),
      )
  }
}

export async function clearAttempts(keys: string[]) {
  const keyHashes = await Promise.all(keys.map((key) => hashToken(key)))
  await getDb()
    .delete(loginAttemptCounters)
    .where(inArray(loginAttemptCounters.keyHash, keyHashes))
}
