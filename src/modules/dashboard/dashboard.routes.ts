import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import { dashboardQuerySchema } from './dashboard.schemas'
import type { DashboardQuery } from './dashboard.schemas'
import { getDashboard } from './dashboard.service'

export const dashboardRoutes = new Hono<AppEnv>()

dashboardRoutes.use('*', requireAuth)

// GET /api/dashboard — Aggregated operations overview (all authenticated users)
dashboardRoutes.get(
  '/',
  zodValidator('query', dashboardQuerySchema),
  async (c) => {
    const query = c.req.valid('query' as never) as DashboardQuery
    const result = await getDashboard(query)
    return c.json(result)
  },
)
