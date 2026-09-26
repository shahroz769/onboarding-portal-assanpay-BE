import { Hono } from 'hono'
import { z } from 'zod'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  createQueueSchema,
  createQueueStageSchema,
  deactivateQueueStageSchema,
  reorderQueueStagesSchema,
  updateQueueSchema,
  updateQueueSlaSchema,
  updateQueueStageSchema,
  updateQueueStatusSchema,
} from './queues.schemas'
import {
  createQueue,
  createQueueStage,
  deactivateQueueStage,
  deleteQueueStage,
  getQueueDetail,
  listQueues,
  listStageTemplates,
  reorderQueueStages,
  updateQueue,
  updateQueueSla,
  updateQueueStage,
  updateQueueStatus,
} from './queues.service'

export const queueRoutes = new Hono<AppEnv>()

const queueIdParam = zodValidator(
  'param',
  z.object({ id: z.uuid({ message: 'Invalid queue id.' }) }),
)
const queueStageParam = zodValidator(
  'param',
  z.object({
    id: z.uuid({ message: 'Invalid queue id.' }),
    stageId: z.uuid({ message: 'Invalid stage id.' }),
  }),
)

queueRoutes.use('*', requireAuth)

queueRoutes.get('/', async (c) => {
  const result = await listQueues({
    includeInactive: c.req.query('includeInactive') === 'true',
  })
  return c.json(result)
})

queueRoutes.get('/templates', requireRoles('super_admin'), async (c) => {
  return c.json(listStageTemplates())
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

queueRoutes.post(
  '/',
  requireRoles('super_admin'),
  zodValidator('json', createQueueSchema),
  async (c) => {
    const input = c.req.valid('json')
    const result = await createQueue(input)
    return c.json(result, 201)
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

queueRoutes.post(
  '/:id/stages',
  requireRoles('super_admin'),
  queueIdParam,
  zodValidator('json', createQueueStageSchema),
  async (c) => {
    const input = c.req.valid('json')
    const result = await createQueueStage(c.req.valid('param').id, input)
    return c.json(result, 201)
  },
)

queueRoutes.patch(
  '/:id/stages/reorder',
  requireRoles('super_admin'),
  queueIdParam,
  zodValidator('json', reorderQueueStagesSchema),
  async (c) => {
    const input = c.req.valid('json')
    const result = await reorderQueueStages(c.req.valid('param').id, input)
    return c.json(result)
  },
)

queueRoutes.patch(
  '/:id/stages/:stageId',
  requireRoles('super_admin'),
  queueStageParam,
  zodValidator('json', updateQueueStageSchema),
  async (c) => {
    const input = c.req.valid('json')
    const result = await updateQueueStage(
      c.req.valid('param').id,
      c.req.valid('param').stageId,
      input,
    )
    return c.json(result)
  },
)

queueRoutes.post(
  '/:id/stages/:stageId/deactivate',
  requireRoles('super_admin'),
  queueStageParam,
  zodValidator('json', deactivateQueueStageSchema),
  async (c) => {
    const input = c.req.valid('json')
    const result = await deactivateQueueStage(
      c.req.valid('param').id,
      c.req.valid('param').stageId,
      input,
    )
    return c.json(result)
  },
)

queueRoutes.delete(
  '/:id/stages/:stageId',
  requireRoles('super_admin'),
  queueStageParam,
  zodValidator(
    'json',
    z.object({ revision: z.coerce.number().int().min(1) }).strict(),
  ),
  async (c) => {
    const input = c.req.valid('json')
    const result = await deleteQueueStage(
      c.req.valid('param').id,
      c.req.valid('param').stageId,
      input.revision,
    )
    return c.json(result)
  },
)
