/**
 * Network contracts for queues (plans 003–004).
 *
 * Dependency-free: no Drizzle, Hono, or app imports.
 * Backend modules re-export these; the frontend mirrors the same string unions
 * in `onboarding-portal-assanpay-FE/src/schemas` at build time only.
 * Do not import this file from the frontend at runtime.
 */

export const QUEUE_WORKFLOW_TYPES = [
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

export type QueueWorkflowType = (typeof QUEUE_WORKFLOW_TYPES)[number]

export const QUEUE_LIFECYCLES = ['draft', 'active', 'inactive'] as const

export type QueueLifecycle = (typeof QUEUE_LIFECYCLES)[number]

/** Wire fields added/emphasized by plans 003–004 on queue DTOs. */
export type QueueContractFields = {
  workflowType: QueueWorkflowType
  lifecycle: QueueLifecycle
  revision: number
}
