import { and, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import { env } from '../../config/env'
import { getDb } from '../../db/client'
import {
  cases,
  queues,
  refreshTokens,
  userQueueAccess,
  users,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import type { RoleType, SessionUser } from '../../types/auth'
import {
  canCreateRole,
  issuePasswordToken,
  revokeAllUserSessions,
} from '../auth/auth.service'
import { sendEmail } from '../email/email.service'
import { UserPasswordEmail } from '../email/templates/user-password'
import type { ListUsersQuery } from './users.schemas'

type QueueAccessInput = {
  queueViewScope?: 'all' | 'selected'
  viewQueueIds?: string[]
  workQueueIds?: string[]
}

type UserMutationInput = QueueAccessInput & {
  name: string
  email: string
  username: string
  roleType: RoleType
  gender: 'male' | 'female'
  status?: 'active' | 'inactive'
}

function formatExpiryDate(date: Date) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi',
  }).format(date)
}

function buildPasswordUrl(token: string) {
  return `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/set-password/${token}`
}

function uniqueValues(values: string[] | undefined) {
  return Array.from(new Set(values ?? []))
}

function sanitizeUserBase(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    gender: user.gender,
    roleType: user.roleType,
    status: user.status,
    queueViewScope: user.queueViewScope,
    createdByUserId: user.createdByUserId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

async function hydrateUsers(baseUsers: Array<typeof users.$inferSelect>) {
  if (baseUsers.length === 0) return []

  const userIds = baseUsers.map((user) => user.id)
  const accessRows = await getDb()
    .select({
      userId: userQueueAccess.userId,
      queueId: userQueueAccess.queueId,
      accessType: userQueueAccess.accessType,
      queueName: queues.name,
    })
    .from(userQueueAccess)
    .innerJoin(queues, eq(userQueueAccess.queueId, queues.id))
    .where(inArray(userQueueAccess.userId, userIds))

  const caseCountRows = await getDb()
    .select({
      ownerId: cases.ownerId,
      count: sql<number>`count(*)::int`,
    })
    .from(cases)
    .where(inArray(cases.ownerId, userIds))
    .groupBy(cases.ownerId)

  const accessByUser = new Map<
    string,
    {
      viewQueueIds: string[]
      workQueueIds: string[]
      viewQueues: Array<{ id: string; name: string }>
      workQueues: Array<{ id: string; name: string }>
    }
  >()

  for (const row of accessRows) {
    const current = accessByUser.get(row.userId) ?? {
      viewQueueIds: [],
      workQueueIds: [],
      viewQueues: [],
      workQueues: [],
    }

    if (row.accessType === 'view') {
      current.viewQueueIds.push(row.queueId)
      current.viewQueues.push({ id: row.queueId, name: row.queueName })
    } else {
      current.workQueueIds.push(row.queueId)
      current.workQueues.push({ id: row.queueId, name: row.queueName })
    }

    accessByUser.set(row.userId, current)
  }

  const countsByUser = new Map(
    caseCountRows
      .filter((row): row is { ownerId: string; count: number } =>
        Boolean(row.ownerId),
      )
      .map((row) => [row.ownerId, row.count]),
  )

  return baseUsers.map((user) => {
    const access = accessByUser.get(user.id)

    return {
      ...sanitizeUserBase(user),
      viewQueueIds: access?.viewQueueIds ?? [],
      workQueueIds: access?.workQueueIds ?? [],
      viewQueues: access?.viewQueues ?? [],
      workQueues: access?.workQueues ?? [],
      ownedCasesCount: countsByUser.get(user.id) ?? 0,
    }
  })
}

async function assertUniqueUser(input: {
  email: string
  username: string
  userId?: string
}) {
  const existingUser = await getDb().query.users.findFirst({
    where: input.userId
      ? and(
          or(eq(users.email, input.email), eq(users.username, input.username)),
          ne(users.id, input.userId),
          isNull(users.deletedAt),
        )
      : and(
          or(eq(users.email, input.email), eq(users.username, input.username)),
          isNull(users.deletedAt),
        ),
  })

  if (!existingUser) return

  if (existingUser.email === input.email) {
    throw new AppError(409, 'Email is already in use.')
  }

  throw new AppError(409, 'Username is already in use.')
}

async function assertQueuesExist(queueIds: string[]) {
  const uniqueQueueIds = uniqueValues(queueIds)
  if (uniqueQueueIds.length === 0) return

  const existingQueues = await getDb().query.queues.findMany({
    where: inArray(queues.id, uniqueQueueIds),
    columns: { id: true },
  })

  if (existingQueues.length !== uniqueQueueIds.length) {
    throw new AppError(400, 'One or more selected queues are invalid.')
  }
}

async function getExistingUserQueueAccess(userId: string) {
  const rows = await getDb()
    .select({
      queueId: userQueueAccess.queueId,
      accessType: userQueueAccess.accessType,
    })
    .from(userQueueAccess)
    .where(eq(userQueueAccess.userId, userId))

  return {
    viewQueueIds: rows
      .filter((row) => row.accessType === 'view')
      .map((row) => row.queueId),
    workQueueIds: rows
      .filter((row) => row.accessType === 'work')
      .map((row) => row.queueId),
  }
}

function normalizeQueueAccess(roleType: RoleType, input: QueueAccessInput) {
  if (roleType !== 'agent') {
    return {
      queueViewScope: 'all' as const,
      viewQueueIds: [],
      workQueueIds: [],
    }
  }

  const queueViewScope = input.queueViewScope ?? 'all'
  const viewQueueIds = uniqueValues(input.viewQueueIds)
  const workQueueIds = uniqueValues(input.workQueueIds)

  if (queueViewScope === 'selected' && viewQueueIds.length === 0) {
    throw new AppError(400, 'Select at least one queue for view access.')
  }

  if (queueViewScope === 'selected') {
    const visible = new Set(viewQueueIds)
    if (workQueueIds.some((queueId) => !visible.has(queueId))) {
      throw new AppError(400, 'Working access must be within view access.')
    }
  }

  return { queueViewScope, viewQueueIds, workQueueIds }
}

async function replaceQueueAccess(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  userId: string,
  access: ReturnType<typeof normalizeQueueAccess>,
) {
  await tx.delete(userQueueAccess).where(eq(userQueueAccess.userId, userId))

  const rows = [
    ...access.viewQueueIds.map((queueId) => ({
      userId,
      queueId,
      accessType: 'view' as const,
    })),
    ...access.workQueueIds.map((queueId) => ({
      userId,
      queueId,
      accessType: 'work' as const,
    })),
  ]

  if (rows.length > 0) {
    await tx.insert(userQueueAccess).values(rows)
  }
}

async function sendPasswordEmail(input: {
  userId: string
  email: string
  name: string
  purpose: 'invite' | 'reset'
  actorId?: string | null
}) {
  const issued = await issuePasswordToken({
    userId: input.userId,
    purpose: input.purpose,
    createdBy: input.actorId,
  })
  const actionUrl = buildPasswordUrl(issued.token)

  const result = await sendEmail({
    to: input.email,
    subject:
      input.purpose === 'invite'
        ? 'Set up your AssanPay onboarding portal account'
        : 'Reset your AssanPay onboarding portal password',
    template: `user-password-${input.purpose}`,
    react: UserPasswordEmail({
      name: input.name,
      actionUrl,
      expiresAt: formatExpiryDate(issued.expiresAt),
      purpose: input.purpose,
    }),
    idempotencyKey: `user-password/${input.purpose}/${input.userId}/${issued.expiresAt.getTime()}`,
    metadata: {
      userId: input.userId,
      purpose: input.purpose,
      expiresAt: issued.expiresAt.toISOString(),
    },
  })

  if (result.status === 'failed') {
    throw new AppError(502, result.error ?? 'Failed to send password email.')
  }

  return result
}

export async function listUsers(query: ListUsersQuery = {}) {
  const conditions = [isNull(users.deletedAt)]

  if (query.search) {
    const term = `%${query.search}%`
    conditions.push(
      or(
        ilike(users.name, term),
        ilike(users.email, term),
        ilike(users.username, term),
      ),
    )
  }

  const roleTypes = (query.roleType?.split(',').filter(Boolean) ??
    []) as RoleType[]
  if (roleTypes.length) {
    conditions.push(inArray(users.roleType, roleTypes))
  }

  const statuses = (query.status?.split(',').filter(Boolean) ?? []) as Array<
    'active' | 'inactive'
  >
  if (statuses.length) {
    conditions.push(inArray(users.status, statuses))
  }

  const result = await getDb().query.users.findMany({
    where: and(...conditions),
    orderBy: (table) => [desc(table.createdAt)],
  })

  return hydrateUsers(result)
}

export async function getUserById(id: string) {
  const user = await getDb().query.users.findFirst({
    where: and(eq(users.id, id), isNull(users.deletedAt)),
  })

  if (!user) {
    throw new AppError(404, 'User not found.')
  }

  const [hydrated] = await hydrateUsers([user])
  return hydrated
}

export async function createUser(actor: SessionUser, input: UserMutationInput) {
  if (!canCreateRole(actor.roleType, input.roleType)) {
    throw new AppError(403, 'You cannot create a user with this role.')
  }

  await assertUniqueUser({
    email: input.email,
    username: input.username,
  })

  const access = normalizeQueueAccess(input.roleType, input)
  await assertQueuesExist([...access.viewQueueIds, ...access.workQueueIds])

  const createdUser = await getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        name: input.name,
        email: input.email,
        username: input.username,
        gender: input.gender,
        roleType: input.roleType,
        status: input.status ?? 'active',
        queueViewScope: access.queueViewScope,
        passwordHash: null,
        createdByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .returning()

    if (!created) {
      throw new AppError(500, 'Failed to create user.')
    }

    await replaceQueueAccess(tx, created.id, access)
    return created
  })

  await sendPasswordEmail({
    userId: createdUser.id,
    email: createdUser.email,
    name: createdUser.name,
    purpose: 'invite',
    actorId: actor.userId,
  })

  const [hydrated] = await hydrateUsers([createdUser])
  return hydrated
}

export async function updateUser(
  actor: SessionUser,
  userId: string,
  input: Partial<Omit<UserMutationInput, 'email' | 'username'>>,
) {
  const existingUser = await getDb().query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
  })

  if (!existingUser) {
    throw new AppError(404, 'User not found.')
  }

  const nextRole = input.roleType ?? existingUser.roleType
  const isChangingRole =
    input.roleType !== undefined && input.roleType !== existingUser.roleType

  if (existingUser.roleType === 'admin' && isChangingRole) {
    throw new AppError(403, 'Admin role cannot be changed.')
  }

  if (isChangingRole) {
    if (!input.roleType || !canCreateRole(actor.roleType, input.roleType)) {
      throw new AppError(403, 'You cannot assign this role.')
    }
  }

  if (actor.roleType === 'supervisor' && existingUser.roleType !== 'agent') {
    throw new AppError(403, 'Supervisors can only update agents.')
  }

  const existingAccess = await getExistingUserQueueAccess(userId)
  const access = normalizeQueueAccess(nextRole, {
    queueViewScope: input.queueViewScope ?? existingUser.queueViewScope,
    viewQueueIds: input.viewQueueIds ?? existingAccess.viewQueueIds,
    workQueueIds: input.workQueueIds ?? existingAccess.workQueueIds,
  })
  await assertQueuesExist([...access.viewQueueIds, ...access.workQueueIds])

  const updatedUser = await getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({
        name: input.name,
        gender: input.gender,
        roleType: input.roleType,
        status: input.status,
        queueViewScope: access.queueViewScope,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning()

    if (!updated) {
      throw new AppError(500, 'Failed to update user.')
    }

    await replaceQueueAccess(tx, userId, access)

    if (
      input.status === 'inactive' ||
      input.roleType ||
      input.queueViewScope ||
      input.viewQueueIds ||
      input.workQueueIds
    ) {
      await tx
        .update(refreshTokens)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(refreshTokens.userId, userId))

      await tx
        .update(users)
        .set({
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
    }

    return updated
  })

  const [hydrated] = await hydrateUsers([updatedUser])
  return hydrated
}

export async function bulkUpdateUserStatus(
  actor: SessionUser,
  ids: string[],
  status: 'active' | 'inactive',
) {
  const uniqueIds = uniqueValues(ids)
  if (uniqueIds.includes(actor.userId) && status === 'inactive') {
    throw new AppError(400, 'You cannot deactivate your own account.')
  }

  if (actor.roleType === 'supervisor') {
    const targetUsers = await getDb().query.users.findMany({
      where: inArray(users.id, uniqueIds),
      columns: { roleType: true },
    })
    if (targetUsers.some((user) => user.roleType !== 'agent')) {
      throw new AppError(403, 'Supervisors can only update agents.')
    }
  }

  const updatedRows = await getDb().transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({
        status,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(and(inArray(users.id, uniqueIds), isNull(users.deletedAt)))
      .returning({ id: users.id })

    await tx
      .update(refreshTokens)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(inArray(refreshTokens.userId, uniqueIds))

    return updated
  })

  return { updated: updatedRows.length }
}

export async function sendResetPassword(actor: SessionUser, userId: string) {
  const user = await getDb().query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
  })

  if (!user) {
    throw new AppError(404, 'User not found.')
  }

  if (actor.roleType === 'supervisor' && user.roleType !== 'agent') {
    throw new AppError(403, 'Supervisors can only reset agent passwords.')
  }

  await sendPasswordEmail({
    userId: user.id,
    email: user.email,
    name: user.name,
    purpose: 'reset',
    actorId: actor.userId,
  })

  return { success: true }
}

export async function deactivateUser(actor: SessionUser, userId: string) {
  if (actor.userId === userId) {
    throw new AppError(400, 'You cannot delete your own account.')
  }

  const existingUser = await getDb().query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
  })

  if (!existingUser) {
    throw new AppError(404, 'User not found.')
  }

  await updateUser(actor, userId, { status: 'inactive' })
  await revokeAllUserSessions(userId)
  return getUserById(userId)
}
