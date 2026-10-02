import { eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { caseHistory, cases, queues, users } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { assertCanWorkCase } from './case-access.service'
import { loadQueueStageForCase } from './case-transition.service'

import { getTestingLimitsAppliedEntry } from './case-detail-lookups'

export async function markTestingLimitsApplied(
  caseId: string,
  userId: string,
) {
  const db = getDb()

  const [caseRow] = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      status: cases.status,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  if (caseRow.workflowType !== 'testing') {
    throw new AppError(400, 'This action is only available for Testing cases.')
  }

  if (caseRow.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }
  await assertCanWorkCase(caseId, userId)

  if (caseRow.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  const currentStage = caseRow.currentStageId
    ? await loadQueueStageForCase(db, caseRow.currentStageId, caseRow.queueId)
    : null

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Testing limits can only be confirmed in an in-progress stage.',
    )
  }

  const existingEntry = await getTestingLimitsAppliedEntry(caseId)
  if (existingEntry) {
    return {
      limitsAppliedAt: existingEntry.createdAt.toISOString(),
      limitsAppliedBy: existingEntry.actorId
        ? {
            id: existingEntry.actorId,
            name: existingEntry.actorName ?? 'Unknown',
          }
        : null,
    }
  }

  const now = new Date()
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'testing_limits_applied',
    details: {
      collection: '10-100',
      disbursement: '1000-50,000',
    },
    createdAt: now,
  })

  const actor = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  })

  return {
    limitsAppliedAt: now.toISOString(),
    limitsAppliedBy: {
      id: userId,
      name: actor?.name ?? 'Unknown',
    },
  }
}
