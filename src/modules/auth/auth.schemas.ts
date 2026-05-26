import { z } from 'zod'

import { roleTypes } from '../../types/auth'

const ASSANPAY_EMAIL_DOMAIN = '@assanpay.com'
const ASSANPAY_EMAIL_MESSAGE = 'Email must use the @assanpay.com domain.'

function assanPayEmail() {
  return z
    .email()
    .transform((value) => value.toLowerCase())
    .refine((value) => value.endsWith(ASSANPAY_EMAIL_DOMAIN), {
      message: ASSANPAY_EMAIL_MESSAGE,
    })
}

function validateQueueAccess(
  value: {
    roleType: (typeof roleTypes)[number]
    queueViewScope: 'all' | 'selected'
    viewQueueIds: string[]
    workQueueIds: string[]
  },
  ctx: z.RefinementCtx,
) {
  if (value.roleType !== 'agent' || value.queueViewScope === 'all') {
    return
  }

  if (value.viewQueueIds.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['viewQueueIds'],
      message: 'Select at least one queue for view access.',
    })
  }

  const viewQueueIds = new Set(value.viewQueueIds)
  if (value.workQueueIds.some((queueId) => !viewQueueIds.has(queueId))) {
    ctx.addIssue({
      code: 'custom',
      path: ['workQueueIds'],
      message: 'Working access must be within view access.',
    })
  }
}

export const registerAdminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.toLowerCase()),
  username: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(128),
})

export const loginSchema = z
  .object({
    identifier: z.string().trim().min(2).max(255).optional(),
    email: z.string().trim().min(2).max(255).optional(),
    password: z.string().min(8).max(128),
  })
  .transform((value, ctx) => {
    const identifier = value.identifier ?? value.email

    if (!identifier) {
      ctx.addIssue({
        code: 'custom',
        path: ['identifier'],
        message: 'Username or email is required.',
      })

      return z.NEVER
    }

    return {
      identifier: identifier.trim().toLowerCase(),
      password: value.password,
    }
  })

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: assanPayEmail(),
    username: z.string().trim().min(2).max(64),
    roleType: z.enum(roleTypes),
    gender: z.enum(['male', 'female']),
    status: z.enum(['active', 'inactive']).default('active'),
    queueViewScope: z.enum(['all', 'selected']).default('all'),
    viewQueueIds: z.array(z.uuid()).default([]),
    workQueueIds: z.array(z.uuid()).default([]),
  })
  .superRefine(validateQueueAccess)

export const passwordTokenParamSchema = z.object({
  token: z.string().min(32).max(256),
})

export const setPasswordSchema = z
  .object({
    token: z.string().min(32).max(256),
    password: z.string().min(8).max(128),
    confirmPassword: z.string().min(8).max(128),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match.',
  })
