import { Hono } from 'hono'
import * as z from 'zod'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  updateQueueSchema,
  updateQueueSlaSchema,
  updateQueueStatusSchema,
} from './queues.schemas'
import {
  getQueueDetail,
  listQueues,
  updateQueue,
  updateQueueSla,
  updateQueueStatus,
} from './queues.service'

export const queueRoutes = new Hono<AppEnv>()

const queueIdParam = zodValidator(
  'param',
  z.object({ id: z.uuid({ error: 'Invalid queue id.' }) }),
)
queueRoutes.use('*', requireAuth)

queueRoutes.get('/', async (c) => {
  const result = await listQueues({
    includeInactive: c.req.query('includeInactive') === 'true',
  })
  return c.json(result)
})

queueRoutes.get(
  '/:id',
  requireRoles('super_admin'),
  queueIdParam,
  async (c) => {
    const result = await getQueueDetail(c.req.valid('param').id)
    return c.json(result)
  },
)

queueRoutes.patch(
  '/:id',
  requireRoles('super_admin'),
  queueIdParam,
  zodValidator('json', updateQueueSchema),
  async (c) => {
    const input = c.req.valid('json')
    const result = await updateQueue(c.req.valid('param').id, input)
    return c.json(result)
  },
)

queueRoutes.patch(
  '/:id/status',
  requireRoles('super_admin'),
  queueIdParam,
  zodValidator('json', updateQueueStatusSchema),
  async (c) => {
    const id = c.req.valid('param').id
    const input = c.req.valid('json')
    const result = await updateQueueStatus(id, input)
    return c.json(result)
  },
)

queueRoutes.patch(
  '/:id/sla',
  requireRoles('super_admin'),
  queueIdParam,
  zodValidator('json', updateQueueSlaSchema),
  async (c) => {
    const id = c.req.valid('param').id
    const input = c.req.valid('json')
    const result = await updateQueueSla(id, input)
    return c.json(result)
  },
)
