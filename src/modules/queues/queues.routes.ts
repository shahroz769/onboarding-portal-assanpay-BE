import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  createQueueSchema,
  updateQueueSlaSchema,
  updateQueueStatusSchema,
} from './queues.schemas'
import type {
  CreateQueueInput,
  UpdateQueueSlaInput,
  UpdateQueueStatusInput,
} from './queues.schemas'
import {
  createQueue,
  listQueues,
  updateQueueSla,
  updateQueueStatus,
} from './queues.service'

export const queueRoutes = new Hono<AppEnv>()

// All routes require authentication
queueRoutes.use('*', requireAuth)

// GET /api/queues — List all queues (all authenticated users)
queueRoutes.get('/', async (c) => {
  const result = await listQueues({
    includeInactive: c.req.query('includeInactive') === 'true',
  })
  return c.json(result)
})

// POST /api/queues — Create queue (admin only)
queueRoutes.post(
  '/',
  requireRoles('admin'),
  zodValidator('json', createQueueSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as CreateQueueInput
    const result = await createQueue(input)
    return c.json(result, 201)
  },
)

queueRoutes.patch(
  '/:id/status',
  requireRoles('admin'),
  zodValidator('json', updateQueueStatusSchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as UpdateQueueStatusInput
    const result = await updateQueueStatus(id, input)
    return c.json(result)
  },
)

queueRoutes.patch(
  '/:id/sla',
  requireRoles('admin'),
  zodValidator('json', updateQueueSlaSchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as UpdateQueueSlaInput
    const result = await updateQueueSla(id, input)
    return c.json(result)
  },
)
