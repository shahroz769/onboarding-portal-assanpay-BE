import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { cases, queues, userQueueAccess, users } from '../../db/schema'
import type { SessionUser } from '../../types/auth'
import { getAgentQueueAccess } from '../cases/case-access.service'

const int = (expr: ReturnType<typeof sql>) => sql<number>`${expr}::int`

/**
 * Open cases (new, working, awaiting merchant) per (queue, owner) pair, right
 * now. The client folds these cells into the queue and team views.
 *
 * Agents only see queues they can view, and only their own cases plus the
 * unassigned pool.
 */
export async function getCaseWorkload(actor: SessionUser) {
  const db = getDb()

  const access =
    actor.roleType === 'agent' ? await getAgentQueueAccess(actor.userId) : null
  const visibleQueueIds =
    access?.viewScope === 'selected' ? access.viewQueueIds : null

  if (visibleQueueIds && visibleQueueIds.length === 0) {
    return { queues: [], members: [], cells: [] }
  }

  const queueCondition = visibleQueueIds
    ? inArray(cases.queueId, visibleQueueIds)
    : undefined
  const ownerCondition = access
    ? or(isNull(cases.ownerId), eq(cases.ownerId, actor.userId))
    : undefined

  const [cells, queueRows] = await Promise.all([
    db
      .select({
        queueId: cases.queueId,
        ownerId: cases.ownerId,
        new: int(sql`count(*) filter (where ${cases.status} = 'new')`),
        working: int(sql`count(*) filter (where ${cases.status} = 'working')`),
        awaitingMerchant: int(
          sql`count(*) filter (where ${cases.status} = 'awaiting_merchant')`,
        ),
      })
      .from(cases)
      .where(and(ne(cases.status, 'closed'), queueCondition, ownerCondition))
      .groupBy(cases.queueId, cases.ownerId),

    db
      .select({ id: queues.id, name: queues.name, isActive: queues.isActive })
      .from(queues)
      .where(visibleQueueIds ? inArray(queues.id, visibleQueueIds) : undefined)
      .orderBy(queues.name),
  ])

  // Inactive queues only matter while they still hold open cases.
  const queueIdsWithCases = new Set(cells.map((cell) => cell.queueId))
  const visibleQueues = queueRows
    .filter((queue) => queue.isActive || queueIdsWithCases.has(queue.id))
    .map(({ id, name }) => ({ id, name }))

  // Team: agents who can work at least one queue (idle ones included, so
  // spare capacity shows), plus anyone else who owns open cases.
  const ownerIds = Array.from(
    new Set(cells.flatMap((cell) => (cell.ownerId ? [cell.ownerId] : []))),
  )
  const memberCondition = access
    ? eq(users.id, actor.userId)
    : or(
        ownerIds.length > 0 ? inArray(users.id, ownerIds) : undefined,
        and(
          eq(users.status, 'active'),
          eq(users.roleType, 'agent'),
          sql`exists (select 1 from ${userQueueAccess} where ${userQueueAccess.userId} = ${users.id} and ${userQueueAccess.accessType} = 'work')`,
        ),
      )

  const members = await db
    .select({ id: users.id, name: users.name, status: users.status })
    .from(users)
    .where(memberCondition)
    .orderBy(users.name)

  return { queues: visibleQueues, members, cells }
}
