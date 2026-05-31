import { z } from 'zod'

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
  })
  .strict()

export type CreateQueueInput = z.infer<typeof createQueueSchema>

export const updateQueueStatusSchema = z
  .object({
    isActive: z.boolean(),
  })
  .strict()

export type UpdateQueueStatusInput = z.infer<typeof updateQueueStatusSchema>

export const updateQueueSlaSchema = z
  .object({
    slaHours: z.coerce.number().int().min(1).max(8760),
  })
  .strict()

export type UpdateQueueSlaInput = z.infer<typeof updateQueueSlaSchema>
