import { z } from 'zod'

import { roleTypes } from '../../types/auth'

export const userIdParamSchema = z.object({
  id: z.uuid(),
})

const queueAccessSchema = z
  .object({
    queueViewScope: z.enum(['all', 'selected']).default('all'),
    viewQueueIds: z.array(z.uuid()).default([]),
    workQueueIds: z.array(z.uuid()).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.queueViewScope === 'selected' && value.viewQueueIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['viewQueueIds'],
        message: 'Select at least one queue for view access.',
      })
    }

    const viewQueueIds = new Set(value.viewQueueIds)
    if (
      value.queueViewScope === 'selected' &&
      value.workQueueIds.some((queueId) => !viewQueueIds.has(queueId))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['workQueueIds'],
        message: 'Working access must be within view access.',
      })
    }
  })

export const listUsersQuerySchema = z.object({
  search: z.string().trim().optional(),
  roleType: z.string().trim().optional(),
  status: z.string().trim().optional(),
})

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    roleType: z.enum(roleTypes).optional(),
    gender: z.enum(['male', 'female']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    queueViewScope: z.enum(['all', 'selected']).optional(),
    viewQueueIds: z.array(z.uuid()).optional(),
    workQueueIds: z.array(z.uuid()).optional(),
  })
  .superRefine((value, ctx) => {
    const parsed = queueAccessSchema.safeParse({
      queueViewScope: value.queueViewScope ?? 'all',
      viewQueueIds: value.viewQueueIds ?? [],
      workQueueIds: value.workQueueIds ?? [],
    })

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        })
      }
    }
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  })

export const bulkUserStatusSchema = z.object({
  ids: z.array(z.uuid()).min(1),
  status: z.enum(['active', 'inactive']),
})

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>
