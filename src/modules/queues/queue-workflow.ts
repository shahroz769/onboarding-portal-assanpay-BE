import {
  QUEUE_LIFECYCLES,
  QUEUE_WORKFLOW_TYPES,
  type QueueLifecycle,
  type QueueWorkflowType,
} from '../../contracts/queues'
import { AppError } from '../../lib/errors'

export {
  QUEUE_LIFECYCLES,
  QUEUE_WORKFLOW_TYPES,
  type QueueLifecycle,
  type QueueWorkflowType,
}

export function lifecycleToIsActive(lifecycle: QueueLifecycle): boolean {
  return lifecycle === 'active'
}

/**
 * The queue lifecycle. A draft queue has never been activated; once it is
 * active or inactive it never returns to draft. Activation also needs the
 * readiness checks in queues.service. Migration 0104 enforces the same moves
 * and keeps is_active mirrored.
 *
 *   draft ──▶ active ◀──▶ inactive ◀── draft
 */
export const QUEUE_LIFECYCLE_TRANSITIONS: Record<
  QueueLifecycle,
  readonly QueueLifecycle[]
> = {
  draft: ['draft', 'active', 'inactive'],
  active: ['active', 'inactive'],
  inactive: ['inactive', 'active'],
}

/**
 * The lifecycle columns to write for a move, with is_active mirrored.
 * Throws 409 for a move the lifecycle does not allow.
 */
export function queueLifecycleFields(
  current: QueueLifecycle,
  next: QueueLifecycle,
) {
  if (!QUEUE_LIFECYCLE_TRANSITIONS[current].includes(next)) {
    throw new AppError(409, `A queue cannot move from ${current} to ${next}.`)
  }
  return { lifecycle: next, isActive: lifecycleToIsActive(next) }
}

export function isActiveToLifecycle(isActive: boolean): QueueLifecycle {
  return isActive ? 'active' : 'inactive'
}

export type StageDefinitionInput = {
  name: string
  slug: string
  order: number
  category: 'new' | 'in_progress' | 'closed'
  isActive?: boolean
  capabilities?: Record<string, unknown> | null
}

export type QueueActivationIssue = {
  code: string
  message: string
}

export function validateStageDefinitions(
  stages: StageDefinitionInput[],
): QueueActivationIssue[] {
  const issues: QueueActivationIssue[] = []

  if (stages.length === 0) {
    issues.push({
      code: 'stages_required',
      message: 'Queue must define at least one stage.',
    })
    return issues
  }

  const activeStages = stages.filter((stage) => stage.isActive !== false)
  const initialStages = activeStages.filter((stage) => stage.category === 'new')
  const terminalStages = activeStages.filter(
    (stage) => stage.category === 'closed',
  )

  if (initialStages.length !== 1) {
    issues.push({
      code: 'initial_stage',
      message: 'Queue must have exactly one active initial (new) stage.',
    })
  }

  if (terminalStages.length < 1) {
    issues.push({
      code: 'terminal_stage',
      message: 'Queue must have at least one active terminal (closed) stage.',
    })
  }

  const orders = new Set<number>()
  const slugs = new Set<string>()
  for (const stage of stages) {
    if (stage.order <= 0) {
      issues.push({
        code: 'stage_order',
        message: `Stage "${stage.slug}" must have a positive order.`,
      })
    }
    if (orders.has(stage.order)) {
      issues.push({
        code: 'stage_order_unique',
        message: `Duplicate stage order ${stage.order}.`,
      })
    }
    orders.add(stage.order)

    if (slugs.has(stage.slug)) {
      issues.push({
        code: 'stage_slug_unique',
        message: `Duplicate stage slug "${stage.slug}".`,
      })
    }
    slugs.add(stage.slug)
  }

  return issues
}

export function getStageTemplateDefinitions(
  template: QueueWorkflowType,
): StageDefinitionInput[] {
  const baseNewWorkingClosed: StageDefinitionInput[] = [
    { name: 'New', slug: 'new', order: 1, category: 'new', isActive: true },
    {
      name: 'Working',
      slug: 'working',
      order: 2,
      category: 'in_progress',
      isActive: true,
    },
    {
      name: 'Closed',
      slug: 'closed',
      order: 3,
      category: 'closed',
      isActive: true,
    },
  ]

  switch (template) {
    case 'document_review':
    case 'agreement':
      return [
        {
          name: 'New',
          slug: 'new',
          order: 1,
          category: 'new',
          isActive: true,
        },
        {
          name: 'Working',
          slug: 'working',
          order: 2,
          category: 'in_progress',
          isActive: true,
        },
        {
          name: 'Awaiting Merchant',
          slug: 'awaiting_merchant',
          order: 3,
          category: 'in_progress',
          isActive: true,
        },
        {
          name: 'Closed',
          slug: 'closed',
          order: 4,
          category: 'closed',
          isActive: true,
        },
      ]
    case 'generic':
    case 'mid':
    case 'testing':
    case 'wordpress':
    case 'physical_agreement':
    case 'live':
    case 'sub_merchant_form':
      return baseNewWorkingClosed
  }
}
