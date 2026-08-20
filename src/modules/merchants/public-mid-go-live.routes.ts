import { Hono } from 'hono'
import { z } from 'zod'

import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  activateMidGoLive,
  getMidGoLiveContext,
} from '../cases/mid-case.service'

export const midGoLiveRoutes = new Hono<AppEnv>()

const activateMidGoLiveSchema = z
  .object({
    testedMethodKeys: z.array(z.string().trim().min(1)).min(1).max(100),
  })
  .strict()

midGoLiveRoutes.get('/:token', async (c) => {
  const token = c.req.param('token')
  const result = await getMidGoLiveContext(token)
  return c.json(result)
})

midGoLiveRoutes.post(
  '/:token',
  zodValidator('json', activateMidGoLiveSchema),
  async (c) => {
    const token = c.req.param('token')
    const input = c.req.valid('json' as never) as z.infer<
      typeof activateMidGoLiveSchema
    >
    const result = await activateMidGoLive(token, input)
    return c.json(result)
  },
)
