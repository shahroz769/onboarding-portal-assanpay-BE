import * as z from 'zod'

import {
  QUEUE_LIFECYCLES,
  QUEUE_WORKFLOW_TYPES,
} from './queue-workflow'

export const updateQueueSchema = z
  .strictObject({
    revision: z.coerce.number().int().min(1),
    name: z.string().min(1).max(120).optional(),
    prefix: z
      .string()
      .min(1)
      .max(4)
      .regex(/^[A-Z]{1,4}$/, {
        error: 'Prefix must be 1-4 uppercase letters.',
      })
      .optional(),
    workflowType: z.enum(QUEUE_WORKFLOW_TYPES).optional(),
    lifecycle: z.enum(QUEUE_LIFECYCLES).optional(),
    /** @deprecated Prefer lifecycle. Kept for backward compatibility. */
    isActive: z.boolean().optional(),
    slaHours: z.coerce.number().int().min(1).max(8760).optional(),
  })
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
  .strictObject({
    lifecycle: z.enum(QUEUE_LIFECYCLES).optional(),
    /** @deprecated Prefer lifecycle. */
    isActive: z.boolean().optional(),
    revision: z.coerce.number().int().min(1).optional(),
  })
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

export const updateQueueSlaSchema = z.strictObject({
  slaHours: z.coerce.number().int().min(1).max(8760),
  revision: z.coerce.number().int().min(1).optional(),
})

export type UpdateQueueSlaInput = z.infer<typeof updateQueueSlaSchema>
