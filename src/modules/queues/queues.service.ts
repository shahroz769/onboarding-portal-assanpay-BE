import { eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { queues, queueCaseSequences } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { ensureQueueStages } from './queue-stage-defaults'
import type {
  CreateQueueInput,
  UpdateQueueSlaInput,
  UpdateQueueStatusInput,
} from './queues.schemas'

export async function listQueues(options: { includeInactive?: boolean } = {}) {
  const db = getDb()

  const query = db
    .select({
      id: queues.id,
      name: queues.name,
      slug: queues.slug,
      prefix: queues.prefix,
      qcEnabled: queues.qcEnabled,
      slaHours: queues.slaHours,
      isActive: queues.isActive,
      createdAt: queues.createdAt,
    })
    .from(queues)

  const rows = await (options.includeInactive
    ? query.orderBy(queues.name)
    : query.where(eq(queues.isActive, true)).orderBy(queues.name))

  return rows
}

export async function createQueue(input: CreateQueueInput) {
  const db = getDb()

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(queues)
      .values({
        name: input.name,
        slug: input.slug,
        prefix: input.prefix,
      })
      .returning()

    if (!created) {
      throw new AppError(500, 'Failed to create queue.')
    }

    await tx.insert(queueCaseSequences).values({
      queueId: created.id,
      lastNumber: 0,
    })

    await ensureQueueStages(tx, {
      id: created.id,
      name: created.name,
      slug: created.slug,
      qcEnabled: created.qcEnabled,
    })

    return {
      id: created.id,
      name: created.name,
      slug: created.slug,
      prefix: created.prefix,
      qcEnabled: created.qcEnabled,
      slaHours: created.slaHours,
      isActive: created.isActive,
      createdAt: created.createdAt,
    }
  })
}

export async function updateQueueStatus(
  id: string,
  input: UpdateQueueStatusInput,
) {
  const db = getDb()
  const [updated] = await db
    .update(queues)
    .set({ isActive: input.isActive })
    .where(eq(queues.id, id))
    .returning({
      id: queues.id,
      name: queues.name,
      slug: queues.slug,
      prefix: queues.prefix,
      qcEnabled: queues.qcEnabled,
      slaHours: queues.slaHours,
      isActive: queues.isActive,
      createdAt: queues.createdAt,
    })

  if (!updated) {
    throw new AppError(404, 'Queue not found.')
  }

  return updated
}

export async function updateQueueSla(id: string, input: UpdateQueueSlaInput) {
  const db = getDb()
  const [updated] = await db
    .update(queues)
    .set({ slaHours: input.slaHours })
    .where(eq(queues.id, id))
    .returning({
      id: queues.id,
      name: queues.name,
      slug: queues.slug,
      prefix: queues.prefix,
      qcEnabled: queues.qcEnabled,
      slaHours: queues.slaHours,
      isActive: queues.isActive,
      createdAt: queues.createdAt,
    })

  if (!updated) {
    throw new AppError(404, 'Queue not found.')
  }

  return updated
}

export async function getQueueById(id: string) {
  const db = getDb()

  const row = await db.query.queues.findFirst({
    where: eq(queues.id, id),
  })

  if (!row) {
    throw new AppError(404, 'Queue not found.')
  }

  return row
}

export async function getQueueBySlug(slug: string) {
  const db = getDb()

  const row = await db.query.queues.findFirst({
    where: eq(queues.slug, slug),
  })

  if (!row) {
    throw new AppError(404, 'Queue not found.')
  }

  return row
}
