import { asc, eq } from 'drizzle-orm'

import { queueStages } from '../../db/schema'
import type { NewQueueStage, QueueStage } from '../../db/schema'
import { AppError } from '../../lib/errors'
import type {
  CaseStatusValue,
  StageCategoryValue,
} from '../cases/cases.schemas'
import {
  getStageTemplateDefinitions,
  type QueueWorkflowType,
} from './queue-workflow'

type QueueStageDb = {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
}

type QueueStageSeedInput = {
  id: string
  name: string
  slug: string
  qcEnabled: boolean
  workflowType: QueueWorkflowType
}

function getStatusForStage(
  stage: Pick<QueueStage, 'category' | 'slug' | 'name'>,
): CaseStatusValue {
  const normalizedSlug = stage.slug.trim().toLowerCase()
  const normalizedName = stage.name.trim().toLowerCase()

  if (
    normalizedSlug === 'awaiting_client' ||
    normalizedSlug === 'awaiting-client' ||
    normalizedName === 'awaiting client' ||
    normalizedName === 'awaiting merchant'
  ) {
    return 'awaiting_client'
  }

  if (
    normalizedSlug === 'pending' ||
    normalizedSlug.includes('pending') ||
    normalizedName === 'pending' ||
    normalizedName.includes('pending')
  ) {
    return 'pending'
  }

  if (normalizedSlug === 'working' || normalizedName === 'working') {
    return 'working'
  }

  if (normalizedSlug === 'error' || normalizedName === 'error') {
    return 'error'
  }

  switch (stage.category) {
    case 'new':
      return 'new'
    case 'in_progress':
      return 'working'
    case 'qc':
      return 'qc'
    case 'error':
      return 'error'
    case 'closed':
      return 'closed'
  }

  return 'working'
}

function stageMatchesStatus(
  stage: Pick<QueueStage, 'category' | 'slug' | 'name'>,
  status: CaseStatusValue,
) {
  return getStatusForStage(stage) === status
}

/**
 * Resolve exactly one stage for a requested status within a queue.
 * Rejects missing or ambiguous status→stage mappings instead of guessing.
 */
export function resolveUniqueStageForStatus(
  stages: Array<
    Pick<
      QueueStage,
      'id' | 'category' | 'slug' | 'name' | 'queueId' | 'order'
    >
  >,
  status: CaseStatusValue,
): Pick<
  QueueStage,
  'id' | 'category' | 'slug' | 'name' | 'queueId' | 'order'
> {
  const matches = stages.filter((stage) => stageMatchesStatus(stage, status))

  if (matches.length === 0) {
    throw new AppError(
      400,
      `No stage in this queue maps to status "${status}".`,
    )
  }

  if (matches.length > 1) {
    throw new AppError(
      400,
      `Status "${status}" maps to multiple stages in this queue; choose an explicit stage transition.`,
    )
  }

  return matches[0]!
}

function createDefaultQueueStageDefinitions(queue: QueueStageSeedInput) {
  return getStageTemplateDefinitions(queue.workflowType).map((stage) => ({
    name: stage.name,
    slug: stage.slug,
    order: stage.order,
    category: stage.category,
  })) satisfies Array<Pick<NewQueueStage, 'name' | 'slug' | 'order' | 'category'>>
}

function hasStageEquivalent(
  queue: QueueStageSeedInput,
  existingStages: QueueStage[],
  stageSlug: string,
) {
  if (existingStages.some((stage) => stage.slug === stageSlug)) {
    return true
  }

  // Legacy documents-review used in-review instead of working.
  if (
    queue.workflowType === 'document_review' &&
    stageSlug === 'working' &&
    existingStages.some((stage) => stage.slug === 'in-review')
  ) {
    return true
  }

  return false
}

export async function ensureQueueStages(
  db: QueueStageDb,
  queue: QueueStageSeedInput,
): Promise<QueueStage[]> {
  const existingStages = await db
    .select()
    .from(queueStages)
    .where(eq(queueStages.queueId, queue.id))
    .orderBy(asc(queueStages.order))

  const defaultStages: Array<
    Pick<NewQueueStage, 'name' | 'slug' | 'order' | 'category'>
  > = createDefaultQueueStageDefinitions(queue)

  if (existingStages.length === 0 && defaultStages.length > 0) {
    return db
      .insert(queueStages)
      .values(
        defaultStages.map((stage) => ({
          queueId: queue.id,
          ...stage,
          isActive: true,
        })),
      )
      .returning()
  }

  if (existingStages.length === 0) {
    return []
  }

  const existingSlugs = new Set(
    existingStages.map((stage: QueueStage) => stage.slug),
  )
  const missingStages = defaultStages.filter(
    (stage: Pick<NewQueueStage, 'name' | 'slug' | 'order' | 'category'>) =>
      !existingSlugs.has(stage.slug) &&
      !hasStageEquivalent(queue, existingStages, stage.slug),
  )

  if (missingStages.length > 0) {
    await db.insert(queueStages).values(
      missingStages.map((stage) => ({
        queueId: queue.id,
        ...stage,
        isActive: true,
      })),
    )
  }

  return db
    .select()
    .from(queueStages)
    .where(eq(queueStages.queueId, queue.id))
    .orderBy(asc(queueStages.order))
}

export function getStageCategoryFromStatus(
  status: CaseStatusValue,
): StageCategoryValue {
  switch (status) {
    case 'new':
      return 'new'
    case 'working':
    case 'pending':
    case 'awaiting_client':
      return 'in_progress'
    case 'qc':
      return 'qc'
    case 'error':
      return 'error'
    case 'closed':
      return 'closed'
  }
}

export function resolveStageForCase(params: {
  stages: QueueStage[]
  currentStageId: string | null
  status: CaseStatusValue
}): QueueStage | null {
  const currentStage = params.currentStageId
    ? (params.stages.find((stage) => stage.id === params.currentStageId) ??
      null)
    : null

  if (currentStage) {
    return currentStage
  }

  const stageForStatus = params.stages.find((stage) =>
    stageMatchesStatus(stage, params.status),
  )

  if (stageForStatus) {
    return stageForStatus
  }

  const inferredCategory = getStageCategoryFromStatus(params.status)
  return (
    params.stages.find((stage) => stage.category === inferredCategory) ??
    params.stages[0] ??
    null
  )
}

export { getStatusForStage, stageMatchesStatus }

/** Prefer active stages; inactive stages stay available when currently referenced. */
export function getVisibleStagesForQueue(
  stages: QueueStage[],
  currentStageId?: string | null,
) {
  return stages.filter(
    (stage) => stage.isActive || stage.id === currentStageId,
  )
}
