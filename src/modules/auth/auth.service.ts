import { and, eq, gt, lt, or, sql } from 'drizzle-orm'

import { env } from '../../config/env'
import { getDb, type DbTransaction } from '../../db/client'
import {
  queues,
  refreshTokens,
  userPasswordTokens,
  userQueueAccess,
  users,
} from '../../db/schema'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../lib/auth'
import { AppError } from '../../lib/errors'
import { hashToken } from '../../lib/security'
import type { RoleType } from '../../types/auth'
import { LINK_DEADLINE_HOURS } from '../configuration/configuration.service'
import {
  clearAttempts,
  getAccountAttemptKey,
  getAttemptBudgets,
  getTrustedDeviceId,
  issueDeviceCookie,
  reserveAttempts,
} from './login-guard'
import {
  closedPasswordLinkError,
  consumePasswordTokens,
  getClosedPasswordLinkReason,
} from './password-token-state'
import { revokeRefreshTokens } from './refresh-token-state'

const roleCreationRules: Record<RoleType, RoleType[]> = {
  super_admin: ['admin', 'agent'],
  admin: ['agent'],
  agent: [],
}

// A rotated refresh token presented again within this window is a benign
// race (two tabs refreshing together, or a retry after a lost response) and is
// only refused. Later than this it is treated as a stolen token.
const REFRESH_TOKEN_REUSE_GRACE_MS = 30_000

// Verified against when the account is unknown or has no password, so a
// failed login costs the same argon2 work either way and response timing does
// not reveal which accounts exist. Hashed lazily with Bun's defaults so its
// parameters always match real password hashes.
let dummyPasswordHash: Promise<string> | undefined

function getDummyPasswordHash() {
  dummyPasswordHash ??= Bun.password.hash(crypto.randomUUID())
  return dummyPasswordHash
}

function getRefreshTokenExpiresAt() {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + env.REFRESH_TOKEN_TTL_DAYS)
  return expiresAt
}

async function getPasswordTokenExpiresAt(purpose: 'invite' | 'reset') {
  const hours =
    purpose === 'invite'
      ? LINK_DEADLINE_HOURS.newPasswordSet
      : LINK_DEADLINE_HOURS.passwordReset
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + hours)
  return expiresAt
}

function generatePublicTokenString(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

// What the frontend needs to show or hide work surfaces. The server re-checks
// access on every request; this only decides what is displayed.
async function getSessionWorkAccess(
  user: typeof users.$inferSelect,
  database: ReturnType<typeof getDb> | DbTransaction = getDb(),
) {
  const rows = await database
    .select({
      queueId: userQueueAccess.queueId,
      workflowType: queues.workflowType,
    })
    .from(userQueueAccess)
    .innerJoin(queues, eq(userQueueAccess.queueId, queues.id))
    .where(
      and(
        eq(userQueueAccess.userId, user.id),
        eq(userQueueAccess.accessType, 'work'),
      ),
    )

  return toSessionWorkAccess(user.roleType, rows)
}

type SessionWorkAccess = {
  workQueueIds: string[]
  canManageEpCases: boolean
}

function toSessionWorkAccess(
  roleType: RoleType,
  rows: Array<{ queueId: string; workflowType: string }>,
): SessionWorkAccess {
  return {
    workQueueIds: rows.map((row) => row.queueId),
    canManageEpCases:
      roleType !== 'agent' ||
      rows.some((row) => row.workflowType === 'sub_merchant_form'),
  }
}

type SanitizableUser = Pick<
  typeof users.$inferSelect,
  | 'id'
  | 'name'
  | 'email'
  | 'username'
  | 'gender'
  | 'roleType'
  | 'status'
  | 'queueViewScope'
  | 'createdByUserId'
  | 'lastLoginAt'
  | 'createdAt'
  | 'updatedAt'
>

function sanitizeUser(user: SanitizableUser, workAccess?: SessionWorkAccess) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    gender: user.gender,
    roleType: user.roleType,
    status: user.status,
    queueViewScope: user.queueViewScope,
    workQueueIds: workAccess?.workQueueIds ?? [],
    canManageEpCases: workAccess?.canManageEpCases ?? user.roleType !== 'agent',
    createdByUserId: user.createdByUserId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

async function issueSession(params: {
  user: typeof users.$inferSelect
  userAgent?: string
  ipAddress?: string
}) {
  const sessionId = crypto.randomUUID()
  const refreshToken = await signRefreshToken({
    sub: params.user.id,
    sessionId,
  })
  const refreshTokenHash = await hashToken(refreshToken)

  await getDb().insert(refreshTokens).values({
    id: sessionId,
    userId: params.user.id,
    tokenHash: refreshTokenHash,
    expiresAt: getRefreshTokenExpiresAt(),
    userAgent: params.userAgent,
    ipAddress: params.ipAddress,
  })

  const accessToken = await signAccessToken({
    sub: params.user.id,
    email: params.user.email,
    roleType: params.user.roleType,
    sessionVersion: params.user.sessionVersion,
  })

  return {
    accessToken,
    refreshToken,
    user: sanitizeUser(params.user, await getSessionWorkAccess(params.user)),
  }
}

/**
 * Signs in and, when `trustDevice` is set, returns a fresh device cookie for
 * the browser (null otherwise, which the route uses to drop any old one).
 * Throttling lives in login-guard.ts.
 */
export async function login(input: {
  identifier: string
  password: string
  trustDevice: boolean
  deviceCookie?: string
  userAgent?: string
  ipAddress: string
}) {
  // Looked up regardless of status so the email and username of one account
  // share a budget; an inactive account is still refused like an unknown one.
  const account = await getDb().query.users.findFirst({
    // Usernames are stored lowercase; lower() also matches the expression
    // index users_username_lower_unique.
    where: or(
      eq(users.email, input.identifier),
      eq(sql`lower(${users.username})`, input.identifier),
    ),
  })
  const user = account?.status === 'active' ? account : undefined
  const accountKey = account?.id ?? input.identifier

  const trustedDeviceId = user
    ? await getTrustedDeviceId(input.deviceCookie, user)
    : null
  const budgets =
    user && trustedDeviceId
      ? getAttemptBudgets({
          trusted: true,
          userId: user.id,
          deviceId: trustedDeviceId,
        })
      : getAttemptBudgets({
          trusted: false,
          account: accountKey,
          ip: input.ipAddress,
        })
  await reserveAttempts(budgets)

  // Unknown accounts and accounts without a password get the same error and
  // the same hashing cost as a wrong password, so neither leaks existence.
  const passwordMatches = await Bun.password.verify(
    input.password,
    user?.passwordHash ?? (await getDummyPasswordHash()),
  )

  if (!user?.passwordHash || !passwordMatches) {
    throw new AppError(401, 'Invalid email or password.')
  }

  // The account holder getting in also lifts a pause others caused on it.
  await clearAttempts([
    ...budgets.map((budget) => budget.key),
    getAccountAttemptKey(accountKey),
  ])

  await getDb()
    .update(users)
    .set({
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))

  // Re-signed on every trusted sign-in, so the trust window rolls forward.
  const deviceCookie = input.trustDevice
    ? await issueDeviceCookie({
        userId: user.id,
        sessionVersion: user.sessionVersion,
        deviceId: trustedDeviceId ?? undefined,
      })
    : null

  const session = await issueSession({
    user,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  })

  return { ...session, deviceCookie }
}

export async function refreshSession(input: {
  refreshToken: string
  userAgent?: string
  ipAddress?: string
}) {
  const payload = await verifyRefreshToken(input.refreshToken).catch(() => {
    throw new AppError(401, 'Invalid refresh token.')
  })

  const hashedToken = await hashToken(input.refreshToken)

  const nextSessionId = crypto.randomUUID()
  const nextRefreshToken = await signRefreshToken({
    sub: payload.userId,
    sessionId: nextSessionId,
  })
  const nextRefreshTokenHash = await hashToken(nextRefreshToken)
  // Raw SQL parameters are sent untyped, so timestamps travel as ISO strings
  // and are cast in the statement.
  const now = new Date().toISOString()
  const nextExpiresAt = getRefreshTokenExpiresAt().toISOString()

  // One statement, so one database round trip, and atomic on its own: retire
  // the presented token, store its replacement, and read back the user with
  // their work access. Only an active, unexpired token of an active user
  // rotates, so of two concurrent refreshes with the same token only one wins.
  // A replacement row inserted by the same statement satisfies the
  // replaced_by_token_id reference, which Postgres checks at statement end.
  const [rotated] = Array.from(
    await getDb().execute(sql<RotatedSessionRawRow>`
    with rotated as (
      update refresh_tokens
         set status = 'rotated',
             revoked_at = ${now}::timestamptz,
             replaced_by_token_id = ${nextSessionId}::uuid
       where id = ${payload.sessionId}::uuid
         and user_id = ${payload.userId}::uuid
         and token_hash = ${hashedToken}
         and status = 'active'
         and expires_at > ${now}::timestamptz
         and exists (
           select 1 from users
            where users.id = ${payload.userId}::uuid
              and users.status = 'active'
         )
      returning user_id
    ),
    inserted as (
      insert into refresh_tokens
        (id, user_id, token_hash, expires_at, user_agent, ip_address)
      select ${nextSessionId}::uuid, rotated.user_id, ${nextRefreshTokenHash},
             ${nextExpiresAt}::timestamptz,
             ${input.userAgent ?? null}::text, ${input.ipAddress ?? null}::text
        from rotated
    )
    select u.id, u.name, u.email, u.username, u.gender,
           u.role_type as "roleType",
           u.status,
           u.queue_view_scope as "queueViewScope",
           u.session_version as "sessionVersion",
           u.created_by_user_id as "createdByUserId",
           u.last_login_at as "lastLoginAt",
           u.created_at as "createdAt",
           u.updated_at as "updatedAt",
           coalesce(
             (select json_agg(json_build_object(
                       'queueId', a.queue_id,
                       'workflowType', q.workflow_type))
                from user_queue_access a
                join queues q on q.id = a.queue_id
               where a.user_id = u.id and a.access_type = 'work'),
             '[]'::json
           ) as "workAccess"
      from users u
      join rotated on rotated.user_id = u.id
  `),
  ) as RotatedSessionRawRow[]

  if (!rotated) {
    return explainFailedRefresh({ payload, hashedToken, input })
  }

  const user: RotatedSessionRow = {
    ...rotated,
    lastLoginAt: toDateOrNull(rotated.lastLoginAt),
    createdAt: new Date(rotated.createdAt),
    updatedAt: new Date(rotated.updatedAt),
  }

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    roleType: user.roleType,
    sessionVersion: user.sessionVersion,
  })

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    user: sanitizeUser(
      user,
      toSessionWorkAccess(user.roleType, user.workAccess),
    ),
  }
}

type RotatedSessionRow = SanitizableUser & {
  sessionVersion: number
  workAccess: Array<{ queueId: string; workflowType: string }>
}

// Raw rows bypass Drizzle's column mapping, so timestamps are normalized here.
type RotatedSessionRawRow = Omit<
  RotatedSessionRow,
  'lastLoginAt' | 'createdAt' | 'updatedAt'
> & {
  lastLoginAt: Date | string | null
  createdAt: Date | string
  updatedAt: Date | string
}

function toDateOrNull(value: Date | string | null) {
  return value === null ? null : new Date(value)
}

/**
 * Slow path, run only when the presented token did not rotate: works out why
 * and answers the way the refresh always has. Outside any transaction, so the
 * reuse response (revoking every session) commits even though the request
 * fails with 401.
 */
async function explainFailedRefresh(params: {
  payload: { userId: string; sessionId: string }
  hashedToken: string
  input: { userAgent?: string; ipAddress?: string }
}): Promise<never> {
  const { payload, hashedToken, input } = params
  const presentedToken = await getDb().query.refreshTokens.findFirst({
    columns: { status: true, revokedAt: true, expiresAt: true },
    where: and(
      eq(refreshTokens.id, payload.sessionId),
      eq(refreshTokens.userId, payload.userId),
      eq(refreshTokens.tokenHash, hashedToken),
    ),
  })

  if (!presentedToken) {
    throw new AppError(401, 'Invalid refresh token.')
  }

  if (presentedToken.status === 'rotated') {
    const rotatedAgoMs = Date.now() - (presentedToken.revokedAt?.getTime() ?? 0)

    if (rotatedAgoMs > REFRESH_TOKEN_REUSE_GRACE_MS) {
      // Only the holder of a copy can present an already-rotated token after
      // the grace window. Revoke everything, including the copy's own chain.
      await revokeAllUserSessions(payload.userId)
      console.warn(
        '[auth] Refresh token reuse detected; revoked all sessions.',
        JSON.stringify({
          userId: payload.userId,
          sessionId: payload.sessionId,
          rotatedAgoMs,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        }),
      )
    }

    throw new AppError(401, 'Refresh token is expired or revoked.')
  }

  if (
    presentedToken.status !== 'active' ||
    presentedToken.expiresAt <= new Date()
  ) {
    throw new AppError(401, 'Refresh token is expired or revoked.')
  }

  // The token is still valid, so either the account is no longer active or a
  // concurrent refresh rotated the token first.
  const activeUser = await getDb().query.users.findFirst({
    columns: { id: true },
    where: and(eq(users.id, payload.userId), eq(users.status, 'active')),
  })

  if (!activeUser) {
    throw new AppError(401, 'User is not available.')
  }

  throw new AppError(401, 'Refresh token is expired or revoked.')
}

export async function logout(refreshToken: string) {
  const payload = await verifyRefreshToken(refreshToken).catch(() => null)

  if (!payload) {
    return
  }

  const hashedToken = await hashToken(refreshToken)

  await revokeRefreshTokens(
    getDb(),
    and(
      eq(refreshTokens.id, payload.sessionId),
      eq(refreshTokens.tokenHash, hashedToken),
    )!,
  )
}

export function canCreateRole(actorRole: RoleType, targetRole: RoleType) {
  return roleCreationRules[actorRole].includes(targetRole)
}

// Issuing does not invalidate earlier links: an undelivered email must not
// burn a link the user may still hold. Call activatePasswordToken once the
// email is accepted, or discardPasswordToken if it was not.
export async function issuePasswordToken(input: {
  userId: string
  purpose: 'invite' | 'reset'
  createdBy?: string | null
}) {
  const token = generatePublicTokenString()
  const tokenHash = await hashToken(token)
  const expiresAt = await getPasswordTokenExpiresAt(input.purpose)

  const [created] = await getDb()
    .insert(userPasswordTokens)
    .values({
      userId: input.userId,
      tokenHash,
      purpose: input.purpose,
      expiresAt,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: userPasswordTokens.id })

  return { tokenId: created!.id, token, expiresAt }
}

/**
 * Retires the user's older open links for the purpose. Only older ones, so two
 * overlapping sends cannot retire each other's delivered link.
 */
export async function activatePasswordToken(input: {
  tokenId: string
  userId: string
  purpose: 'invite' | 'reset'
}) {
  await consumePasswordTokens(
    getDb(),
    and(
      eq(userPasswordTokens.userId, input.userId),
      eq(userPasswordTokens.purpose, input.purpose),
      lt(
        userPasswordTokens.createdAt,
        sql`(select ${userPasswordTokens.createdAt} from ${userPasswordTokens} where ${userPasswordTokens.id} = ${input.tokenId})`,
      ),
    )!,
    'superseded',
  )
}

export async function discardPasswordToken(tokenId: string) {
  await getDb()
    .delete(userPasswordTokens)
    .where(eq(userPasswordTokens.id, tokenId))
}

async function findPasswordLink(tokenHash: string) {
  const [row] = await getDb()
    .select({
      tokenId: userPasswordTokens.id,
      purpose: userPasswordTokens.purpose,
      expiresAt: userPasswordTokens.expiresAt,
      consumedAt: userPasswordTokens.consumedAt,
      consumedReason: userPasswordTokens.consumedReason,
      userId: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
    })
    .from(userPasswordTokens)
    .innerJoin(users, eq(userPasswordTokens.userId, users.id))
    .where(eq(userPasswordTokens.tokenHash, tokenHash))
    .limit(1)
  return row ?? null
}

async function loadValidPasswordToken(token: string) {
  const row = await findPasswordLink(await hashToken(token))
  const closedReason = getClosedPasswordLinkReason(row)

  if (closedReason) throw closedPasswordLinkError(closedReason)
  if (row!.status !== 'active') throw closedPasswordLinkError('invalid')

  return row!
}

export async function getPasswordTokenContext(token: string) {
  const row = await loadValidPasswordToken(token)

  return {
    name: row.name,
    email: row.email,
    purpose: row.purpose,
    expiresAt: row.expiresAt,
  }
}

export async function setPasswordWithToken(input: {
  token: string
  password: string
}) {
  const tokenHash = await hashToken(input.token)
  // Cheap lookup first: the password hash below is deliberately slow and
  // memory-heavy, so a made-up or closed link must never reach it. The claim
  // in the transaction still decides atomically.
  const link = await findPasswordLink(tokenHash)
  const closedReason = getClosedPasswordLinkReason(link)
  if (closedReason) throw closedPasswordLinkError(closedReason)
  if (link!.status !== 'active') throw closedPasswordLinkError('invalid')

  const passwordHash = await Bun.password.hash(input.password)

  const [updatedUser] = await getDb().transaction(async (tx) => {
    const [claimedToken] = await consumePasswordTokens(
      tx,
      and(
        eq(userPasswordTokens.tokenHash, tokenHash),
        gt(userPasswordTokens.expiresAt, new Date()),
      )!,
      'used',
    )

    if (!claimedToken) {
      // Expired, or consumed meanwhile (possibly by a concurrent submit).
      throw closedPasswordLinkError(
        getClosedPasswordLinkReason(await findPasswordLink(tokenHash)) ??
          'invalid',
      )
    }

    const user = await tx.query.users.findFirst({
      where: and(eq(users.id, claimedToken.userId), eq(users.status, 'active')),
      columns: { id: true },
    })

    if (!user) {
      throw closedPasswordLinkError('invalid')
    }

    const [updated] = await tx
      .update(users)
      .set({
        passwordHash,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning()

    await revokeRefreshTokens(tx, eq(refreshTokens.userId, user.id))

    // Any other invite/reset link still open for this user is now stale.
    await consumePasswordTokens(
      tx,
      eq(userPasswordTokens.userId, user.id),
      'invalidated',
    )

    return [updated]
  })

  if (!updatedUser) {
    throw new AppError(500, 'Failed to set password.')
  }

  return sanitizeUser(updatedUser)
}

export async function revokeAllUserSessions(userId: string) {
  await getDb().transaction(async (tx) => {
    await revokeRefreshTokens(tx, eq(refreshTokens.userId, userId))

    await tx
      .update(users)
      .set({
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
  })
}
