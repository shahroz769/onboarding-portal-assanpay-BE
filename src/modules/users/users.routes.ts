import { Hono } from 'hono'

import { zodValidator } from '../../lib/validators'
import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import type { AppEnv } from '../../types/auth'
import { createUserSchema } from '../auth/auth.schemas'
import {
  bulkUserStatusSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userIdParamSchema,
} from './users.schemas'
import {
  bulkUpdateUserStatus,
  createUser,
  deactivateUser,
  getUserById,
  listUsers,
  sendResetPassword,
  updateUser,
} from './users.service'

export const userRoutes = new Hono<AppEnv>()

userRoutes.use('*', requireAuth)

userRoutes.get(
  '/',
  zodValidator('query', listUsersQuerySchema),
  requireRoles('admin', 'supervisor'),
  async (c) => {
    const query = c.req.valid('query')
    const users = await listUsers(query)
    return c.json({ users })
  },
)

userRoutes.post(
  '/bulk-status',
  zodValidator('json', bulkUserStatusSchema),
  requireRoles('admin', 'supervisor'),
  async (c) => {
    const input = c.req.valid('json')
    const result = await bulkUpdateUserStatus(
      c.var.auth,
      input.ids,
      input.status,
    )
    return c.json(result)
  },
)

userRoutes.post(
  '/:id/reset-password',
  zodValidator('param', userIdParamSchema),
  requireRoles('admin', 'supervisor'),
  async (c) => {
    const { id } = c.req.valid('param')
    const result = await sendResetPassword(c.var.auth, id)
    return c.json(result)
  },
)

userRoutes.get(
  '/:id',
  zodValidator('param', userIdParamSchema),
  requireRoles('admin', 'supervisor'),
  async (c) => {
    const { id } = c.req.valid('param')
    const user = await getUserById(id)
    return c.json({ user })
  },
)

userRoutes.post(
  '/',
  zodValidator('json', createUserSchema),
  requireRoles('admin', 'supervisor'),
  async (c) => {
    const input = c.req.valid('json')
    const user = await createUser(c.var.auth, input)
    return c.json({ user }, 201)
  },
)

userRoutes.patch(
  '/:id',
  zodValidator('param', userIdParamSchema),
  zodValidator('json', updateUserSchema),
  requireRoles('admin', 'supervisor'),
  async (c) => {
    const { id } = c.req.valid('param')
    const input = c.req.valid('json')
    const user = await updateUser(c.var.auth, id, input)
    return c.json({ user })
  },
)

userRoutes.delete(
  '/:id',
  zodValidator('param', userIdParamSchema),
  requireRoles('admin'),
  async (c) => {
    const { id } = c.req.valid('param')
    const user = await deactivateUser(c.var.auth, id)
    return c.json({ user })
  },
)
