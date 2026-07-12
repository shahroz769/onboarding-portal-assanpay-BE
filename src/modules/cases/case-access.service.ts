import { eq, inArray } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { cases, queues, userQueueAccess, users } from '../../db/schema'
import { AppError } from '../../lib/errors'
import type { SessionUser } from '../../types/auth'

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

type DbExecutor = ReturnType<typeof getDb> | DbTransaction

export async function getAgentQueueAccess(
  userId: string,
  database: DbExecutor = getDb(),
) {
  const user = await database.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { roleType: true, queueViewScope: true },
  })

  if (!user || user.roleType !== 'agent') return null

  const rows = await database
    .select({
      queueId: userQueueAccess.queueId,
      accessType: userQueueAccess.accessType,
    })
    .from(userQueueAccess)
    .where(eq(userQueueAccess.userId, userId))

  return {
    viewScope: user.queueViewScope,
    viewQueueIds: rows
      .filter((row) => row.accessType === 'view')
      .map((row) => row.queueId),
    workQueueIds: rows
      .filter((row) => row.accessType === 'work')
      .map((row) => row.queueId),
  }
}

export async function assertCanViewCase(
  caseId: string,
  actor?: SessionUser,
) {
  if (!actor || actor.roleType !== 'agent') return

  const access = await getAgentQueueAccess(actor.userId)
  if (!access || access.viewScope === 'all') return

  const caseRow = await getDb().query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { queueId: true },
  })

  if (!caseRow) throw new AppError(404, 'Case not found.')
  if (!access.viewQueueIds.includes(caseRow.queueId)) {
    throw new AppError(403, 'You do not have access to this queue.')
  }
}

export async function assertCanWorkCase(
  caseId: string,
  userId: string,
  database: DbExecutor = getDb(),
) {
  const access = await getAgentQueueAccess(userId, database)
  if (!access) return

  const caseRow = await database.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { queueId: true },
  })

  if (!caseRow) throw new AppError(404, 'Case not found.')
  if (!access.workQueueIds.includes(caseRow.queueId)) {
    throw new AppError(403, 'You do not have working access to this queue.')
  }
}

export async function assertOwnerCanWorkCases(
  ownerId: string | null,
  caseIds: string[],
  database: DbExecutor = getDb(),
) {
  if (!ownerId) return

  const access = await getAgentQueueAccess(ownerId, database)
  if (!access) return

  const rows = await database
    .select({ queueId: cases.queueId, queueName: queues.name })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(inArray(cases.id, caseIds))

  const workQueueIds = new Set(access.workQueueIds)
  const inaccessibleQueueNames = Array.from(
    new Set(
      rows
        .filter((row) => !workQueueIds.has(row.queueId))
        .map((row) => row.queueName),
    ),
  )

  if (inaccessibleQueueNames.length > 0) {
    throw new AppError(
      403,
      `Selected employee does not have work access to: ${inaccessibleQueueNames.join(', ')}.`,
    )
  }
}

export async function assertCaseOwner(
  caseId: string,
  userId: string,
  database: DbExecutor = getDb(),
) {
  const caseRow = await database.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { ownerId: true },
  })

  if (!caseRow) throw new AppError(404, 'Case not found.')
  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the current case owner can work on this case.')
  }
}
