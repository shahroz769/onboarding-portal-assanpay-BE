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
import type {
  CreateQueueInput,
  CreateQueueStageInput,
  DeactivateQueueStageInput,
  ReorderQueueStagesInput,
  UpdateQueueInput,
  UpdateQueueSlaInput,
  UpdateQueueStageInput,
  UpdateQueueStatusInput,
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

queueRoutes.get('/:id', requireRoles('super_admin'), async (c) => {
  const result = await getQueueDetail(c.req.param('id'))
  return c.json(result)
})

queueRoutes.post(
  '/',
  requireRoles('super_admin'),
  zodValidator('json', createQueueSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as CreateQueueInput
    const result = await createQueue(input)
    return c.json(result, 201)
  },
)

queueRoutes.patch(
  '/:id',
  requireRoles('super_admin'),
  zodValidator('json', updateQueueSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as UpdateQueueInput
    const result = await updateQueue(c.req.param('id'), input)
    return c.json(result)
  },
)

queueRoutes.patch(
  '/:id/status',
  requireRoles('super_admin'),
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
  requireRoles('super_admin'),
  zodValidator('json', updateQueueSlaSchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as UpdateQueueSlaInput
    const result = await updateQueueSla(id, input)
    return c.json(result)
  },
)

queueRoutes.post(
  '/:id/stages',
  requireRoles('super_admin'),
  zodValidator('json', createQueueStageSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as CreateQueueStageInput
    const result = await createQueueStage(c.req.param('id'), input)
    return c.json(result, 201)
  },
)

queueRoutes.patch(
  '/:id/stages/reorder',
  requireRoles('super_admin'),
  zodValidator('json', reorderQueueStagesSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as ReorderQueueStagesInput
    const result = await reorderQueueStages(c.req.param('id'), input)
    return c.json(result)
  },
)

queueRoutes.patch(
  '/:id/stages/:stageId',
  requireRoles('super_admin'),
  zodValidator('json', updateQueueStageSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as UpdateQueueStageInput
    const result = await updateQueueStage(
      c.req.param('id'),
      c.req.param('stageId'),
      input,
    )
    return c.json(result)
  },
)

queueRoutes.post(
  '/:id/stages/:stageId/deactivate',
  requireRoles('super_admin'),
  zodValidator('json', deactivateQueueStageSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as DeactivateQueueStageInput
    const result = await deactivateQueueStage(
      c.req.param('id'),
      c.req.param('stageId'),
      input,
    )
    return c.json(result)
  },
)

queueRoutes.delete(
  '/:id/stages/:stageId',
  requireRoles('super_admin'),
  zodValidator(
    'json',
    z.object({ revision: z.coerce.number().int().min(1) }).strict(),
  ),
  async (c) => {
    const input = c.req.valid('json' as never) as { revision: number }
    const result = await deleteQueueStage(
      c.req.param('id'),
      c.req.param('stageId'),
      input.revision,
    )
    return c.json(result)
  },
)
