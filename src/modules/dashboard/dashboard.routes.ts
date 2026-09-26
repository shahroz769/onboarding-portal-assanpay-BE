import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  applyPortalMidLimitsSchema,
  dashboardQuerySchema,
} from './dashboard.schemas'
import type {
  ApplyPortalMidLimitsInput,
  DashboardQuery,
} from './dashboard.schemas'
import { applyPortalMidLimits, getDashboard } from './dashboard.service'

export const dashboardRoutes = new Hono<AppEnv>()

dashboardRoutes.use('*', requireAuth)

// GET /api/dashboard — Aggregated operations overview (all authenticated users)
dashboardRoutes.get(
  '/',
  zodValidator('query', dashboardQuerySchema),
  async (c) => {
    const query = c.req.valid('query')
    const result = await getDashboard(query)
    return c.json(result)
  },
)

dashboardRoutes.post(
  '/portal-mids/apply-limits',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', applyPortalMidLimitsSchema),
  async (c) => {
    const input = c.req.valid('json')
    const auth = c.get('auth')
    const result = await applyPortalMidLimits(input, auth.userId)
    return c.json(result)
  },
)
