import type { Queue } from '../../db/schema'
import {
  QUEUE_LIFECYCLES,
  QUEUE_WORKFLOW_TYPES,
  type QueueLifecycle,
  type QueueWorkflowType,
} from '../../contracts/queues'

export {
  QUEUE_LIFECYCLES,
  QUEUE_WORKFLOW_TYPES,
  type QueueLifecycle,
  type QueueWorkflowType,
}

export const QUEUE_STAGE_TEMPLATES = [
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

export type QueueStageTemplateName = (typeof QUEUE_STAGE_TEMPLATES)[number]

/** Historical slug → workflow type. Migration / backfill only — not runtime dispatch. */
export const LEGACY_QUEUE_SLUG_WORKFLOW_MAP = {
  'documents-review': 'document_review',
  agreement: 'agreement',
  'merchant-id': 'mid',
  testing: 'testing',
  'wordpress-website': 'wordpress',
  'dialogpay-card': 'card',
  'physical-agreement': 'physical_agreement',
  live: 'live',
  'sub-merchant-form': 'sub_merchant_form',
  'support-ticket': 'generic',
} as const satisfies Record<string, QueueWorkflowType>

export function getQueueWorkflowType(
  queue: Pick<Queue, 'workflowType'> | { workflowType: QueueWorkflowType },
): QueueWorkflowType {
  return queue.workflowType
}

export function isQueueWorkflowType(
  queue: Pick<Queue, 'workflowType'> | { workflowType: QueueWorkflowType },
  workflowType: QueueWorkflowType,
): boolean {
  return queue.workflowType === workflowType
}

export function lifecycleToIsActive(lifecycle: QueueLifecycle): boolean {
  return lifecycle === 'active'
}

export function isActiveToLifecycle(isActive: boolean): QueueLifecycle {
  return isActive ? 'active' : 'inactive'
}

export type StageDefinitionInput = {
  name: string
  slug: string
  order: number
  category: 'new' | 'in_progress' | 'qc' | 'error' | 'closed'
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
  template: QueueStageTemplateName,
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
          slug: 'awaiting_client',
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
    case 'card':
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
          name: 'Merchant Pending',
          slug: 'merchant_pending',
          order: 3,
          category: 'in_progress',
          isActive: true,
        },
        {
          name: 'Docs Upload',
          slug: 'docs_upload',
          order: 4,
          category: 'in_progress',
          isActive: true,
        },
        {
          name: 'Docs Pending',
          slug: 'docs_pending',
          order: 5,
          category: 'in_progress',
          isActive: true,
        },
        {
          name: 'Closed',
          slug: 'closed',
          order: 6,
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

export function resolveStageDefinitionsForCreate(input: {
  workflowType: QueueWorkflowType
  stageTemplate?: QueueStageTemplateName
  stages?: StageDefinitionInput[]
}): StageDefinitionInput[] {
  if (input.stages && input.stages.length > 0) {
    return input.stages.map((stage) => ({
      ...stage,
      isActive: stage.isActive !== false,
      capabilities: stage.capabilities ?? null,
    }))
  }

  const template = input.stageTemplate ?? input.workflowType
  return getStageTemplateDefinitions(template)
}
