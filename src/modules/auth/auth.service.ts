import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'

import { env } from '../../config/env'
import { getDb } from '../../db/client'
import {
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
import type { RoleType, SessionUser } from '../../types/auth'
import { getLinkDeadlineSettings } from '../configuration/configuration.service'

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
  const linkDeadlines = await getLinkDeadlineSettings()
  const hours =
    purpose === 'invite'
      ? linkDeadlines.newPasswordSetHours
      : linkDeadlines.passwordResetHours
  if (hours == null) {
    return new Date(Date.UTC(9999, 11, 31)) // no expiry
  }
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + hours)
  return expiresAt
}

function generatePublicTokenString(): string {
  const bytes = new Uint8Array(64)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}

function sanitizeUser(
  user: typeof users.$inferSelect,
  workQueueIds: string[] = [],
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    gender: user.gender,
    roleType: user.roleType,
    status: user.status,
    queueViewScope: user.queueViewScope,
    workQueueIds,
    createdByUserId: user.createdByUserId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

async function assertUniqueUser(input: { email: string; username: string }) {
  const existingUser = await getDb().query.users.findFirst({
    where: and(
      or(eq(users.email, input.email), eq(users.username, input.username)),
      isNull(users.deletedAt),
    ),
  })

  if (!existingUser) {
    return
  }

  if (existingUser.email === input.email) {
    throw new AppError(409, 'Email is already in use.')
  }

  throw new AppError(409, 'Username is already in use.')
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

  const workQueueRows = await getDb()
    .select({ queueId: userQueueAccess.queueId })
    .from(userQueueAccess)
    .where(
      and(
        eq(userQueueAccess.userId, params.user.id),
        eq(userQueueAccess.accessType, 'work'),
      ),
    )

  return {
    accessToken,
    refreshToken,
    user: sanitizeUser(
      params.user,
      workQueueRows.map((row) => row.queueId),
    ),
  }
}

export async function registerSuperAdmin(input: {
  name: string
  email: string
  username: string
  password: string
}) {
  if (!env.ALLOW_SUPER_ADMIN_REGISTRATION) {
    throw new AppError(403, 'Super Admin registration is disabled.')
  }

  await assertUniqueUser({
    email: input.email,
    username: input.username,
  })

  const passwordHash = await Bun.password.hash(input.password)

  const [createdUser] = await getDb()
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      username: input.username,
      passwordHash,
      roleType: 'super_admin',
      status: 'active',
    })
    .returning()

  return sanitizeUser(createdUser)
}

/**
 * Rate-limit key for login attempts on one account. Matches the same user
 * lookup as `login`, so the email and the username of an account share one
 * budget; unknown identifiers fall back to the normalized identifier.
 */
export async function getLoginAccountKey(identifier: string) {
  const user = await getDb().query.users.findFirst({
    columns: { id: true },
    where: and(
      or(eq(users.email, identifier), eq(users.username, identifier)),
      isNull(users.deletedAt),
    ),
  })

  return user ? `user:${user.id}` : `account:${identifier.toLowerCase()}`
}

export async function login(input: {
  identifier: string
  password: string
  userAgent?: string
  ipAddress?: string
}) {
  const user = await getDb().query.users.findFirst({
    where: and(
      or(
        eq(users.email, input.identifier),
        eq(users.username, input.identifier),
      ),
      eq(users.status, 'active'),
      isNull(users.deletedAt),
    ),
  })

  // Unknown accounts and accounts without a password get the same error and
  // the same hashing cost as a wrong password, so neither leaks existence.
  const passwordMatches = await Bun.password.verify(
    input.password,
    user?.passwordHash ?? (await getDummyPasswordHash()),
  )

  if (!user?.passwordHash || !passwordMatches) {
    throw new AppError(401, 'Invalid email or password.')
  }

  await getDb()
    .update(users)
    .set({
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))

  return issueSession({
    user,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  })
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

  // Looked up outside the rotation transaction: the reuse response below must
  // commit even though the request itself fails with 401.
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
    const rotatedAgoMs =
      Date.now() - (presentedToken.revokedAt?.getTime() ?? 0)

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

  const nextSessionId = crypto.randomUUID()
  const nextRefreshToken = await signRefreshToken({
    sub: payload.userId,
    sessionId: nextSessionId,
  })
  const nextRefreshTokenHash = await hashToken(nextRefreshToken)

  return getDb().transaction(async (tx) => {
    const user = await tx.query.users.findFirst({
      where: and(
        eq(users.id, payload.userId),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
      ),
    })

    if (!user) {
      throw new AppError(401, 'User is not available.')
    }

    await tx.insert(refreshTokens).values({
      id: nextSessionId,
      userId: user.id,
      tokenHash: nextRefreshTokenHash,
      expiresAt: getRefreshTokenExpiresAt(),
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    })

    // Still guarded on status='active': of two concurrent refreshes with the
    // same token, only one can rotate it.
    const [rotatedToken] = await tx
      .update(refreshTokens)
      .set({
        status: 'rotated',
        revokedAt: new Date(),
        replacedByTokenId: nextSessionId,
      })
      .where(
        and(
          eq(refreshTokens.id, payload.sessionId),
          eq(refreshTokens.userId, payload.userId),
          eq(refreshTokens.tokenHash, hashedToken),
          eq(refreshTokens.status, 'active'),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .returning({
        id: refreshTokens.id,
      })

    if (!rotatedToken) {
      throw new AppError(401, 'Refresh token is expired or revoked.')
    }

    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      roleType: user.roleType,
      sessionVersion: user.sessionVersion,
    })

    const workQueueRows = await tx
      .select({ queueId: userQueueAccess.queueId })
      .from(userQueueAccess)
      .where(
        and(
          eq(userQueueAccess.userId, user.id),
          eq(userQueueAccess.accessType, 'work'),
        ),
      )

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      user: sanitizeUser(
        user,
        workQueueRows.map((row) => row.queueId),
      ),
    }
  })
}

export async function logout(refreshToken: string) {
  const payload = await verifyRefreshToken(refreshToken).catch(() => null)

  if (!payload) {
    return
  }

  const hashedToken = await hashToken(refreshToken)

  await getDb()
    .update(refreshTokens)
    .set({
      status: 'revoked',
      revokedAt: new Date(),
    })
    .where(
      and(
        eq(refreshTokens.id, payload.sessionId),
        eq(refreshTokens.tokenHash, hashedToken),
      ),
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
  await getDb()
    .update(userPasswordTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(userPasswordTokens.userId, input.userId),
        eq(userPasswordTokens.purpose, input.purpose),
        isNull(userPasswordTokens.consumedAt),
        lt(
          userPasswordTokens.createdAt,
          sql`(select ${userPasswordTokens.createdAt} from ${userPasswordTokens} where ${userPasswordTokens.id} = ${input.tokenId})`,
        ),
      ),
    )
}

export async function discardPasswordToken(tokenId: string) {
  await getDb()
    .delete(userPasswordTokens)
    .where(eq(userPasswordTokens.id, tokenId))
}

async function loadValidPasswordToken(token: string) {
  const tokenHash = await hashToken(token)
  const [row] = await getDb()
    .select({
      tokenId: userPasswordTokens.id,
      purpose: userPasswordTokens.purpose,
      expiresAt: userPasswordTokens.expiresAt,
      userId: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(userPasswordTokens)
    .innerJoin(users, eq(userPasswordTokens.userId, users.id))
    .where(
      and(
        eq(userPasswordTokens.tokenHash, tokenHash),
        isNull(userPasswordTokens.consumedAt),
        gt(userPasswordTokens.expiresAt, new Date()),
      ),
    )
    .limit(1)

  if (!row || row.deletedAt || row.status !== 'active') {
    throw new AppError(410, 'This password link is expired or invalid.')
  }

  return row
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
  const passwordHash = await Bun.password.hash(input.password)

  const [updatedUser] = await getDb().transaction(async (tx) => {
    const [claimedToken] = await tx
      .update(userPasswordTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(userPasswordTokens.tokenHash, tokenHash),
          isNull(userPasswordTokens.consumedAt),
          gt(userPasswordTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: userPasswordTokens.userId })

    if (!claimedToken) {
      throw new AppError(410, 'This password link is expired or invalid.')
    }

    const user = await tx.query.users.findFirst({
      where: and(
        eq(users.id, claimedToken.userId),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
      ),
      columns: { id: true },
    })

    if (!user) {
      throw new AppError(410, 'This password link is expired or invalid.')
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

    await tx
      .update(refreshTokens)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(refreshTokens.userId, user.id))

    // Any other invite/reset link still open for this user is now stale.
    await tx
      .update(userPasswordTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(userPasswordTokens.userId, user.id),
          isNull(userPasswordTokens.consumedAt),
        ),
      )

    return [updated]
  })

  if (!updatedUser) {
    throw new AppError(500, 'Failed to set password.')
  }

  return sanitizeUser(updatedUser)
}

export async function createManagedUser(
  actor: SessionUser,
  input: {
    name: string
    email: string
    username: string
    password: string
    roleType: RoleType
    gender?: 'male' | 'female'
  },
) {
  if (!canCreateRole(actor.roleType, input.roleType)) {
    throw new AppError(403, 'You cannot create a user with this role.')
  }

  await assertUniqueUser({
    email: input.email,
    username: input.username,
  })

  const passwordHash = await Bun.password.hash(input.password)

  const [createdUser] = await getDb()
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      username: input.username,
      gender: input.gender ?? 'male',
      passwordHash,
      roleType: input.roleType,
      status: 'active',
      createdByUserId: actor.userId,
    })
    .returning()

  return sanitizeUser(createdUser)
}

export async function revokeAllUserSessions(userId: string) {
  await getDb().transaction(async (tx) => {
    await tx
      .update(refreshTokens)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
      })
      .where(eq(refreshTokens.userId, userId))

    await tx
      .update(users)
      .set({
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
  })
}
