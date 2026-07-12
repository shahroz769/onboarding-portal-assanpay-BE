import { and, asc, count, eq, ne, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  cases,
  queueCaseSequences,
  queues,
  queueStages,
} from '../../db/schema'
import type { Queue, QueueStage } from '../../db/schema'
import { AppError } from '../../lib/errors'
import {
  getStageTemplateDefinitions,
  isActiveToLifecycle,
  lifecycleToIsActive,
  resolveStageDefinitionsForCreate,
  validateStageDefinitions,
  type QueueActivationIssue,
  type QueueLifecycle,
  type StageDefinitionInput,
} from './queue-workflow'
import type {
  CreateQueueInput,
  CreateQueueStageInput,
  DeactivateQueueStageInput,
  ReorderQueueStagesInput,
  UpdateQueueInput,
  UpdateQueueSlaInput,
  UpdateQueueStageInput,
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
    qcEnabled: queue.qcEnabled,
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

async function loadQueueStages(db: Tx | ReturnType<typeof getDb>, queueId: string) {
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

async function stageIsReferenced(
  db: Tx | ReturnType<typeof getDb>,
  stageId: string,
) {
  const [row] = await db
    .select({ total: count() })
    .from(cases)
    .where(eq(cases.currentStageId, stageId))
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

function assertValidStagesOrThrow(
  stages: StageDefinitionInput[],
  statusCode: 409 | 422 = 422,
) {
  const issues = validateStageDefinitions(stages)
  if (issues.length > 0) {
    throw new AppError(
      statusCode,
      'Queue stage definition is invalid.',
      { issues },
    )
  }
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
    card: [],
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
      qcEnabled: queues.qcEnabled,
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

export async function createQueue(input: CreateQueueInput) {
  const db = getDb()
  const stageDefinitions = resolveStageDefinitionsForCreate({
    workflowType: input.workflowType,
    stageTemplate: input.stageTemplate,
    stages: input.stages,
  })

  assertValidStagesOrThrow(stageDefinitions)

  const lifecycle = input.lifecycle ?? 'draft'
  const isActive = lifecycleToIsActive(lifecycle)

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(queues)
      .values({
        name: input.name,
        slug: input.slug,
        prefix: input.prefix,
        workflowType: input.workflowType,
        lifecycle,
        revision: 1,
        qcEnabled: input.qcEnabled ?? false,
        slaHours: input.slaHours ?? 24,
        isActive,
      })
      .returning()

    if (!created) {
      throw new AppError(500, 'Failed to create queue.')
    }

    await tx.insert(queueCaseSequences).values({
      queueId: created.id,
      lastNumber: 0,
    })

    const insertedStages = await tx
      .insert(queueStages)
      .values(
        stageDefinitions.map((stage) => ({
          queueId: created.id,
          name: stage.name,
          slug: stage.slug,
          order: stage.order,
          category: stage.category,
          isActive: stage.isActive !== false,
          capabilities: stage.capabilities ?? null,
        })),
      )
      .returning()

    return mapQueueDto(created, insertedStages)
  })
}

export async function updateQueue(id: string, input: UpdateQueueInput) {
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
      const candidateStages =
        input.stages ??
        (await loadQueueStages(tx, id)).map((stage) => ({
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

    if (input.stages) {
      assertValidStagesOrThrow(input.stages)
      const currentStages = await loadQueueStages(tx, id)
      const incomingBySlug = new Map(
        input.stages.map((stage) => [stage.slug, stage]),
      )

      for (const current of currentStages) {
        if (!incomingBySlug.has(current.slug)) {
          if (await stageIsReferenced(tx, current.id)) {
            throw new AppError(
              409,
              `Cannot remove stage "${current.slug}" because cases reference it. Deactivate it instead.`,
            )
          }
        }
      }

      // Replace unreferenced stages transactionally: deactivate missing,
      // update existing by slug, insert new.
      for (const current of currentStages) {
        const next = incomingBySlug.get(current.slug)
        if (!next) {
          if (await stageIsReferenced(tx, current.id)) {
            await tx
              .update(queueStages)
              .set({ isActive: false })
              .where(eq(queueStages.id, current.id))
          } else {
            await tx.delete(queueStages).where(eq(queueStages.id, current.id))
          }
          continue
        }

        await tx
          .update(queueStages)
          .set({
            name: next.name,
            order: next.order,
            category: next.category,
            isActive: next.isActive !== false,
            capabilities: next.capabilities ?? null,
          })
          .where(eq(queueStages.id, current.id))
      }

      const existingSlugs = new Set(currentStages.map((stage) => stage.slug))
      const toInsert = input.stages.filter(
        (stage) => !existingSlugs.has(stage.slug),
      )
      if (toInsert.length > 0) {
        await tx.insert(queueStages).values(
          toInsert.map((stage) => ({
            queueId: id,
            name: stage.name,
            slug: stage.slug,
            order: stage.order,
            category: stage.category,
            isActive: stage.isActive !== false,
            capabilities: stage.capabilities ?? null,
          })),
        )
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
        qcEnabled: input.qcEnabled ?? bumped.qcEnabled,
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
    input.lifecycle ??
    isActiveToLifecycle(input.isActive ?? false)

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

export async function createQueueStage(
  queueId: string,
  input: CreateQueueStageInput,
) {
  const db = getDb()
  return db.transaction(async (tx) => {
    const existing = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    if (!existing) {
      throw new AppError(404, 'Queue not found.')
    }

    const stages = await loadQueueStages(tx, queueId)
    const nextStages: StageDefinitionInput[] = [
      ...stages.map((stage) => ({
        name: stage.name,
        slug: stage.slug,
        order: stage.order,
        category: stage.category,
        isActive: stage.isActive,
        capabilities: stage.capabilities,
      })),
      {
        name: input.name,
        slug: input.slug,
        order: input.order,
        category: input.category,
        isActive: input.isActive !== false,
        capabilities: input.capabilities ?? null,
      },
    ]
    assertValidStagesOrThrow(nextStages)

    await bumpQueueRevision(tx, queueId, input.revision)

    const [created] = await tx
      .insert(queueStages)
      .values({
        queueId,
        name: input.name,
        slug: input.slug,
        order: input.order,
        category: input.category,
        isActive: input.isActive !== false,
        capabilities: input.capabilities ?? null,
      })
      .returning()

    if (!created) {
      throw new AppError(500, 'Failed to create stage.')
    }

    const queue = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    const allStages = await loadQueueStages(tx, queueId)
    return mapQueueDto(queue!, allStages)
  })
}

export async function updateQueueStage(
  queueId: string,
  stageId: string,
  input: UpdateQueueStageInput,
) {
  const db = getDb()
  return db.transaction(async (tx) => {
    const existing = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    if (!existing) {
      throw new AppError(404, 'Queue not found.')
    }

    const stage = await tx.query.queueStages.findFirst({
      where: and(eq(queueStages.id, stageId), eq(queueStages.queueId, queueId)),
    })
    if (!stage) {
      throw new AppError(404, 'Stage not found.')
    }

    const stages = await loadQueueStages(tx, queueId)
    const nextStages = stages.map((item) =>
      item.id === stageId
        ? {
            name: input.name ?? item.name,
            slug: input.slug ?? item.slug,
            order: input.order ?? item.order,
            category: input.category ?? item.category,
            isActive: input.isActive ?? item.isActive,
            capabilities:
              input.capabilities !== undefined
                ? input.capabilities
                : item.capabilities,
          }
        : {
            name: item.name,
            slug: item.slug,
            order: item.order,
            category: item.category,
            isActive: item.isActive,
            capabilities: item.capabilities,
          },
    )
    assertValidStagesOrThrow(nextStages)

    await bumpQueueRevision(tx, queueId, input.revision)

    await tx
      .update(queueStages)
      .set({
        name: input.name ?? stage.name,
        slug: input.slug ?? stage.slug,
        order: input.order ?? stage.order,
        category: input.category ?? stage.category,
        isActive: input.isActive ?? stage.isActive,
        capabilities:
          input.capabilities !== undefined
            ? input.capabilities
            : stage.capabilities,
      })
      .where(eq(queueStages.id, stageId))

    const queue = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    const allStages = await loadQueueStages(tx, queueId)
    return mapQueueDto(queue!, allStages)
  })
}

export async function deactivateQueueStage(
  queueId: string,
  stageId: string,
  input: DeactivateQueueStageInput,
) {
  return updateQueueStage(queueId, stageId, {
    revision: input.revision,
    isActive: false,
  })
}

export async function deleteQueueStage(
  queueId: string,
  stageId: string,
  revision: number,
) {
  const db = getDb()
  return db.transaction(async (tx) => {
    const existing = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    if (!existing) {
      throw new AppError(404, 'Queue not found.')
    }

    const stage = await tx.query.queueStages.findFirst({
      where: and(eq(queueStages.id, stageId), eq(queueStages.queueId, queueId)),
    })
    if (!stage) {
      throw new AppError(404, 'Stage not found.')
    }

    if (await stageIsReferenced(tx, stageId)) {
      throw new AppError(
        409,
        'Cannot delete a stage referenced by existing cases. Deactivate it instead.',
      )
    }

    const remaining = (await loadQueueStages(tx, queueId))
      .filter((item) => item.id !== stageId)
      .map((item) => ({
        name: item.name,
        slug: item.slug,
        order: item.order,
        category: item.category,
        isActive: item.isActive,
        capabilities: item.capabilities,
      }))

    if (remaining.length > 0) {
      assertValidStagesOrThrow(remaining)
    } else if (existing.lifecycle === 'active') {
      throw new AppError(
        422,
        'Cannot delete the last stage of an active queue.',
      )
    }

    await bumpQueueRevision(tx, queueId, revision)
    await tx.delete(queueStages).where(eq(queueStages.id, stageId))

    const queue = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    const allStages = await loadQueueStages(tx, queueId)
    return mapQueueDto(queue!, allStages)
  })
}

export async function reorderQueueStages(
  queueId: string,
  input: ReorderQueueStagesInput,
) {
  const db = getDb()
  return db.transaction(async (tx) => {
    const existing = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    if (!existing) {
      throw new AppError(404, 'Queue not found.')
    }

    const stages = await loadQueueStages(tx, queueId)
    if (stages.length !== input.stageIds.length) {
      throw new AppError(422, 'Reorder must include every stage exactly once.')
    }

    const stageById = new Map(stages.map((stage) => [stage.id, stage]))
    for (const stageId of input.stageIds) {
      if (!stageById.has(stageId)) {
        throw new AppError(422, 'Reorder includes an unknown stage.')
      }
    }

    await bumpQueueRevision(tx, queueId, input.revision)

    // Two-phase update to avoid unique (queue_id, order) collisions.
    for (let index = 0; index < input.stageIds.length; index += 1) {
      await tx
        .update(queueStages)
        .set({ order: -(index + 1) })
        .where(eq(queueStages.id, input.stageIds[index]!))
    }
    for (let index = 0; index < input.stageIds.length; index += 1) {
      await tx
        .update(queueStages)
        .set({ order: index + 1 })
        .where(eq(queueStages.id, input.stageIds[index]!))
    }

    const queue = await tx.query.queues.findFirst({
      where: eq(queues.id, queueId),
    })
    const allStages = await loadQueueStages(tx, queueId)
    return mapQueueDto(queue!, allStages)
  })
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

export async function getQueueByWorkflowType(
  workflowType: Queue['workflowType'],
) {
  const db = getDb()

  const row = await db.query.queues.findFirst({
    where: and(
      eq(queues.workflowType, workflowType),
      ne(queues.lifecycle, 'inactive'),
    ),
  })

  return row ?? null
}

export function listStageTemplates() {
  return (
    [
      'generic',
      'document_review',
      'agreement',
      'mid',
      'testing',
      'wordpress',
      'card',
      'physical_agreement',
      'live',
      'sub_merchant_form',
    ] as const
  ).map((name) => ({
    name,
    stages: getStageTemplateDefinitions(name),
  }))
}
