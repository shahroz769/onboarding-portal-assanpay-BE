import { eq, sql } from 'drizzle-orm'

import { queueCaseSequences, queues } from '../../db/schema'
import { AppError } from '../../lib/errors'
import type { DbTransaction } from './case-db'

export async function generateCaseNumber(
  tx: DbTransaction,
  queueId: string,
): Promise<string> {
  // Get queue prefix
  const queue = await tx.query.queues.findFirst({
    where: eq(queues.id, queueId),
    columns: { prefix: true },
  })

  if (!queue) {
    throw new AppError(404, 'Queue not found.')
  }

  await tx
    .insert(queueCaseSequences)
    .values({ queueId, lastNumber: 0 })
    .onConflictDoNothing()

  // Atomically increment the sequence counter
  const [updated] = await tx
    .update(queueCaseSequences)
    .set({
      lastNumber: sql`${queueCaseSequences.lastNumber} + 1`,
    })
    .where(eq(queueCaseSequences.queueId, queueId))
    .returning({ lastNumber: queueCaseSequences.lastNumber })

  if (!updated) {
    throw new AppError(
      500,
      'Failed to generate case number. Queue sequence not found.',
    )
  }

  const paddedNumber = String(updated.lastNumber).padStart(9, '0')
  return `${queue.prefix}-${paddedNumber}`
}
