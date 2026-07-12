import { z } from 'zod'

import {
  QUEUE_LIFECYCLES,
  QUEUE_STAGE_TEMPLATES,
  QUEUE_WORKFLOW_TYPES,
} from './queue-workflow'

const stageCategorySchema = z.enum([
  'new',
  'in_progress',
  'qc',
  'error',
  'closed',
])

export const queueStageDefinitionSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, {
        message:
          'Stage slug must be lowercase alphanumeric with hyphens or underscores.',
      }),
    order: z.coerce.number().int().min(1),
    category: stageCategorySchema,
    isActive: z.boolean().optional().default(true),
    capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()

export const createQueueSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'Slug must be lowercase alphanumeric with hyphens.',
      }),
    prefix: z
      .string()
      .min(1)
      .max(4)
      .regex(/^[A-Z]{1,4}$/, {
        message: 'Prefix must be 1-4 uppercase letters.',
      }),
    workflowType: z.enum(QUEUE_WORKFLOW_TYPES),
    lifecycle: z.enum(QUEUE_LIFECYCLES).optional().default('draft'),
    qcEnabled: z.boolean().optional().default(false),
    slaHours: z.coerce.number().int().min(1).max(8760).optional().default(24),
    stageTemplate: z.enum(QUEUE_STAGE_TEMPLATES).optional(),
    stages: z.array(queueStageDefinitionSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lifecycle === 'active') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Queues must be created as draft or inactive; activate after stages are ready.',
        path: ['lifecycle'],
      })
    }
  })

export type CreateQueueInput = z.infer<typeof createQueueSchema>

export const updateQueueSchema = z
  .object({
    revision: z.coerce.number().int().min(1),
    name: z.string().min(1).max(120).optional(),
    prefix: z
      .string()
      .min(1)
      .max(4)
      .regex(/^[A-Z]{1,4}$/, {
        message: 'Prefix must be 1-4 uppercase letters.',
      })
      .optional(),
    workflowType: z.enum(QUEUE_WORKFLOW_TYPES).optional(),
    lifecycle: z.enum(QUEUE_LIFECYCLES).optional(),
    /** @deprecated Prefer lifecycle. Kept for backward compatibility. */
    isActive: z.boolean().optional(),
    qcEnabled: z.boolean().optional(),
    slaHours: z.coerce.number().int().min(1).max(8760).optional(),
    stages: z.array(queueStageDefinitionSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lifecycle !== undefined && value.isActive !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either lifecycle or isActive, not both.',
        path: ['lifecycle'],
      })
    }
  })

export type UpdateQueueInput = z.infer<typeof updateQueueSchema>

export const updateQueueStatusSchema = z
  .object({
    lifecycle: z.enum(QUEUE_LIFECYCLES).optional(),
    /** @deprecated Prefer lifecycle. */
    isActive: z.boolean().optional(),
    revision: z.coerce.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lifecycle === undefined && value.isActive === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide lifecycle or isActive.',
        path: ['lifecycle'],
      })
    }
    if (value.lifecycle !== undefined && value.isActive !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either lifecycle or isActive, not both.',
        path: ['lifecycle'],
      })
    }
  })

export type UpdateQueueStatusInput = z.infer<typeof updateQueueStatusSchema>

export const updateQueueSlaSchema = z
  .object({
    slaHours: z.coerce.number().int().min(1).max(8760),
    revision: z.coerce.number().int().min(1).optional(),
  })
  .strict()

export type UpdateQueueSlaInput = z.infer<typeof updateQueueSlaSchema>

export const createQueueStageSchema = z
  .object({
    revision: z.coerce.number().int().min(1),
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, {
        message:
          'Stage slug must be lowercase alphanumeric with hyphens or underscores.',
      }),
    order: z.coerce.number().int().min(1),
    category: stageCategorySchema,
    isActive: z.boolean().optional().default(true),
    capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()

export type CreateQueueStageInput = z.infer<typeof createQueueStageSchema>

export const updateQueueStageSchema = z
  .object({
    revision: z.coerce.number().int().min(1),
    name: z.string().min(1).max(120).optional(),
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, {
        message:
          'Stage slug must be lowercase alphanumeric with hyphens or underscores.',
      })
      .optional(),
    order: z.coerce.number().int().min(1).optional(),
    category: stageCategorySchema.optional(),
    isActive: z.boolean().optional(),
    capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()

export type UpdateQueueStageInput = z.infer<typeof updateQueueStageSchema>

export const reorderQueueStagesSchema = z
  .object({
    revision: z.coerce.number().int().min(1),
    stageIds: z.array(z.string().uuid()).min(1),
  })
  .strict()

export type ReorderQueueStagesInput = z.infer<typeof reorderQueueStagesSchema>

export const deactivateQueueStageSchema = z
  .object({
    revision: z.coerce.number().int().min(1),
  })
  .strict()

export type DeactivateQueueStageInput = z.infer<
  typeof deactivateQueueStageSchema
>
