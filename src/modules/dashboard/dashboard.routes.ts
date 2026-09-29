import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  applyPortalMidLimitsSchema,
  awaitingPhysicalAgreementsQuerySchema,
  dashboardQuerySchema,
  pendingPortalMidValuesQuerySchema,
  pendingPortalMidsQuerySchema,
} from './dashboard.schemas'
import {
  applyPortalMidLimits,
  getDashboard,
  listAwaitingPhysicalAgreementsPage,
  listPendingPortalMidLimitsPage,
  listPendingPortalMidValues,
} from './dashboard.service'
import { getCaseWorkload } from './dashboard-workload.service'

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

// GET /api/dashboard/workload — Open cases per queue and owner, right now.
// Agents get their own cases and the unassigned pool.
dashboardRoutes.get('/workload', async (c) => {
  const result = await getCaseWorkload(c.get('auth'))
  return c.json(result)
})

// GET /api/dashboard/portal-mids/pending — Paged MIDs awaiting limits
dashboardRoutes.get(
  '/portal-mids/pending',
  zodValidator('query', pendingPortalMidsQuerySchema),
  async (c) => {
    const result = await listPendingPortalMidLimitsPage(c.req.valid('query'))
    return c.json(result)
  },
)

// GET /api/dashboard/portal-mids/pending/mids — Every pending MID (for copy)
dashboardRoutes.get(
  '/portal-mids/pending/mids',
  zodValidator('query', pendingPortalMidValuesQuerySchema),
  async (c) => {
    const result = await listPendingPortalMidValues(c.req.valid('query'))
    return c.json(result)
  },
)

// GET /api/dashboard/agreements/awaiting-physical — Sent agreements whose
// signed physical copy has not been received yet
dashboardRoutes.get(
  '/agreements/awaiting-physical',
  zodValidator('query', awaitingPhysicalAgreementsQuerySchema),
  async (c) => {
    const result = await listAwaitingPhysicalAgreementsPage(
      c.req.valid('query'),
    )
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
