import { Hono } from 'hono'

import type { AppEnv } from '../../types/auth'
import {
  activateMidGoLive,
  getMidGoLiveContext,
} from '../cases/cases.service'

export const midGoLiveRoutes = new Hono<AppEnv>()

midGoLiveRoutes.get('/:token', async (c) => {
  const token = c.req.param('token')
  const result = await getMidGoLiveContext(token)
  return c.json(result)
})

midGoLiveRoutes.post('/:token', async (c) => {
  const token = c.req.param('token')
  const result = await activateMidGoLive(token)
  return c.json(result)
})
