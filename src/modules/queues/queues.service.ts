import { and, asc, count, eq, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { cases, queueCaseSequences, queues, queueStages } from '../../db/schema'
import type { Queue, QueueStage } from '../../db/schema'
import { AppError } from '../../lib/errors'
import {
  isActiveToLifecycle,
  lifecycleToIsActive,
  validateStageDefinitions,
  type QueueActivationIssue,
  type QueueLifecycle,
} from './queue-workflow'
import type {
  UpdateQueueInput,
  UpdateQueueSlaInput,
  UpdateQueueStatusInput,
} from './queues.schemas'

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

function mapQueueDto(queue: Queue, stages?: QueueStage[]) {
  return {
    id: queue.id,
    name: queue.name,
    slug: queue.slug,
    prefix: queue.prefix,
    workflowType: queue.workflowType,
    lifecycle: queue.lifecycle,
    revision: queue.revision,
    slaHours: queue.slaHours,
    isActive: queue.isActive,
    createdAt: queue.createdAt,
    ...(stages
      ? {
          stages: stages.map(mapStageDto),
        }
      : {}),
  }
}

function mapStageDto(stage: QueueStage) {
  return {
    id: stage.id,
    queueId: stage.queueId,
    name: stage.name,
    slug: stage.slug,
    order: stage.order,
    category: stage.category,
    isActive: stage.isActive,
    capabilities: stage.capabilities ?? null,
    createdAt: stage.createdAt,
  }
}

async function loadQueueStages(
  db: Tx | ReturnType<typeof getDb>,
  queueId: string,
) {
  return db
    .select()
    .from(queueStages)
    .where(eq(queueStages.queueId, queueId))
    .orderBy(asc(queueStages.order))
}

async function queueHasCases(
  db: Tx | ReturnType<typeof getDb>,
  queueId: string,
) {
  const [row] = await db
    .select({ total: count() })
    .from(cases)
    .where(eq(cases.queueId, queueId))
  return Number(row?.total ?? 0) > 0
}

async function bumpQueueRevision(
  tx: Tx,
  queueId: string,
  expectedRevision: number,
) {
  const [bumped] = await tx
    .update(queues)
    .set({
      revision: sql`${queues.revision} + 1`,
    })
    .where(and(eq(queues.id, queueId), eq(queues.revision, expectedRevision)))
    .returning()

  if (!bumped) {
    const current = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
      columns: { revision: true },
    })
    throw new AppError(
      409,
      'Queue was updated by someone else. Reload and try again.',
      { revision: current?.revision ?? expectedRevision },
    )
  }

  return bumped
}

export async function evaluateQueueActivationReadiness(
  queue: Queue,
  stages: QueueStage[],
): Promise<{ ready: boolean; issues: QueueActivationIssue[] }> {
  const issues: QueueActivationIssue[] = []

  issues.push(
    ...validateStageDefinitions(
      stages.map((stage) => ({
        name: stage.name,
        slug: stage.slug,
        order: stage.order,
        category: stage.category,
        isActive: stage.isActive,
        capabilities: stage.capabilities,
      })),
    ),
  )

  if (!queue.prefix || queue.prefix.trim().length === 0) {
    issues.push({
      code: 'prefix_required',
      message: 'Queue prefix is required before activation.',
    })
  }

  const db = getDb()
  const sequence = await db.query.queueCaseSequences.findFirst({
    where: eq(queueCaseSequences.queueId, queue.id),
  })
  if (!sequence) {
    issues.push({
      code: 'sequence_required',
      message: 'Queue case sequence is missing.',
    })
  }

  if (queue.slaHours <= 0) {
    issues.push({
      code: 'sla_positive',
      message: 'Queue SLA hours must be positive.',
    })
  }

  const specializedRequiredCapabilities: Partial<
    Record<Queue['workflowType'], string[]>
  > = {
    document_review: [],
    agreement: [],
    mid: [],
    testing: [],
    wordpress: [],
    physical_agreement: [],
    live: [],
    sub_merchant_form: [],
    generic: [],
  }

  const required = specializedRequiredCapabilities[queue.workflowType] ?? []
  if (required.length > 0) {
    const activeCapabilities = new Set(
      stages
        .filter((stage) => stage.isActive)
        .flatMap((stage) =>
          stage.capabilities && typeof stage.capabilities === 'object'
            ? Object.keys(stage.capabilities)
            : [],
        ),
    )
    for (const capability of required) {
      if (!activeCapabilities.has(capability)) {
        issues.push({
          code: 'capability_required',
          message: `Queue is missing required capability "${capability}".`,
        })
      }
    }
  }

  return { ready: issues.length === 0, issues }
}

export async function listQueues(options: { includeInactive?: boolean } = {}) {
  const db = getDb()

  const query = db
    .select({
      id: queues.id,
      name: queues.name,
      slug: queues.slug,
      prefix: queues.prefix,
      workflowType: queues.workflowType,
      lifecycle: queues.lifecycle,
      revision: queues.revision,
      slaHours: queues.slaHours,
      isActive: queues.isActive,
      createdAt: queues.createdAt,
    })
    .from(queues)

  const rows = await (options.includeInactive
    ? query.orderBy(queues.name)
    : query.where(eq(queues.lifecycle, 'active')).orderBy(queues.name))

  return rows
}

export async function getQueueDetail(id: string) {
  const db = getDb()
  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, id),
  })

  if (!queue) {
    throw new AppError(404, 'Queue not found.')
  }

  const stages = await loadQueueStages(db, queue.id)
  const readiness = await evaluateQueueActivationReadiness(queue, stages)

  return {
    ...mapQueueDto(queue, stages),
    activation: readiness,
  }
}

export async function updateQueue(id: string, input: UpdateQueueInput) {
  if (input.workflowType === 'physical_agreement') {
    throw new AppError(400, 'The Physical Agreement workflow has been retired.')
  }

  const db = getDb()

  return db.transaction(async (tx) => {
    const existing = await tx.query.queues.findFirst({
      where: eq(queues.id, id),
    })
    if (!existing) {
      throw new AppError(404, 'Queue not found.')
    }

    if (
      input.prefix !== undefined &&
      input.prefix !== existing.prefix &&
      (await queueHasCases(tx, id))
    ) {
      throw new AppError(
        409,
        'Queue prefix cannot be changed after cases exist.',
      )
    }

    if (
      input.workflowType !== undefined &&
      input.workflowType !== existing.workflowType &&
      (await queueHasCases(tx, id))
    ) {
      throw new AppError(
        409,
        'Queue workflow type cannot be changed after cases exist.',
      )
    }

    let nextLifecycle = existing.lifecycle
    if (input.lifecycle !== undefined) {
      nextLifecycle = input.lifecycle
    } else if (input.isActive !== undefined) {
      nextLifecycle = isActiveToLifecycle(input.isActive)
    }

    if (nextLifecycle === 'active') {
      const candidateStages = (await loadQueueStages(tx, id)).map((stage) => ({
          name: stage.name,
          slug: stage.slug,
          order: stage.order,
          category: stage.category,
          isActive: stage.isActive,
          capabilities: stage.capabilities,
        }))
      const previewQueue = {
        ...existing,
        prefix: input.prefix ?? existing.prefix,
        slaHours: input.slaHours ?? existing.slaHours,
        workflowType: input.workflowType ?? existing.workflowType,
        lifecycle: nextLifecycle,
      }
      const readiness = await evaluateQueueActivationReadiness(
        previewQueue,
        candidateStages.map((stage, index) => ({
          id: `preview-${index}`,
          queueId: id,
          name: stage.name,
          slug: stage.slug,
          order: stage.order,
          category: stage.category,
          isActive: stage.isActive !== false,
          capabilities: stage.capabilities ?? null,
          createdAt: new Date(),
        })),
      )
      if (!readiness.ready) {
        throw new AppError(422, 'Queue is not ready for activation.', {
          issues: readiness.issues,
        })
      }
    }

    const bumped = await bumpQueueRevision(tx, id, input.revision)

    const [updated] = await tx
      .update(queues)
      .set({
        name: input.name ?? bumped.name,
        prefix: input.prefix ?? bumped.prefix,
        workflowType: input.workflowType ?? bumped.workflowType,
        lifecycle: nextLifecycle,
        isActive: lifecycleToIsActive(nextLifecycle),
        slaHours: input.slaHours ?? bumped.slaHours,
      })
      .where(eq(queues.id, id))
      .returning()

    if (!updated) {
      throw new AppError(404, 'Queue not found.')
    }

    const stages = await loadQueueStages(tx, id)
    return mapQueueDto(updated, stages)
  })
}

export async function updateQueueStatus(
  id: string,
  input: UpdateQueueStatusInput,
) {
  const lifecycle: QueueLifecycle =
    input.lifecycle ?? isActiveToLifecycle(input.isActive ?? false)

  const db = getDb()
  return db.transaction(async (tx) => {
    const existing = await tx.query.queues.findFirst({
      where: eq(queues.id, id),
    })
    if (!existing) {
      throw new AppError(404, 'Queue not found.')
    }

    if (lifecycle === 'active') {
      const stages = await loadQueueStages(tx, id)
      const readiness = await evaluateQueueActivationReadiness(existing, stages)
      if (!readiness.ready) {
        throw new AppError(422, 'Queue is not ready for activation.', {
          issues: readiness.issues,
        })
      }
    }

    const expectedRevision = input.revision ?? existing.revision
    const bumped = await bumpQueueRevision(tx, id, expectedRevision)

    const [updated] = await tx
      .update(queues)
      .set({
        lifecycle,
        isActive: lifecycleToIsActive(lifecycle),
      })
      .where(eq(queues.id, id))
      .returning()

    if (!updated) {
      throw new AppError(404, 'Queue not found.')
    }

    void bumped
    return mapQueueDto(updated)
  })
}

export async function updateQueueSla(id: string, input: UpdateQueueSlaInput) {
  const db = getDb()
  return db.transaction(async (tx) => {
    const existing = await tx.query.queues.findFirst({
      where: eq(queues.id, id),
    })
    if (!existing) {
      throw new AppError(404, 'Queue not found.')
    }

    const expectedRevision = input.revision ?? existing.revision
    await bumpQueueRevision(tx, id, expectedRevision)

    const [updated] = await tx
      .update(queues)
      .set({ slaHours: input.slaHours })
      .where(eq(queues.id, id))
      .returning()

    if (!updated) {
      throw new AppError(404, 'Queue not found.')
    }

    return mapQueueDto(updated)
  })
}
