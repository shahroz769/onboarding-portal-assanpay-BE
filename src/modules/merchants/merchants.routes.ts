import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  bulkIdsSchema,
  bulkPrioritySchema,
  bulkTerminateMerchantsSchema,
  listMerchantsQuerySchema,
  merchantLimitsMdrSchema,
  permanentlyDeleteMerchantSchema,
  terminateMerchantSchema,
  updatePrioritySchema,
} from './merchants.schemas'
import type {
  BulkIdsInput,
  BulkPriorityInput,
  BulkTerminateMerchantsInput,
  ListMerchantsQuery,
  MerchantLimitsMdr,
  PermanentlyDeleteMerchantInput,
  TerminateMerchantInput,
  UpdatePriorityInput,
} from './merchants.schemas'
import {
  bulkSoftDeleteMerchants,
  bulkTerminateMerchants,
  bulkUpdatePriority,
  getMerchantForm,
  getMerchantHeader,
  getMerchantHistory,
  getMerchantLimits,
  getMerchantOverview,
  listMerchants,
  permanentlyDeleteMerchant,
  resetMerchantLimitsMdr,
  softDeleteMerchant,
  terminateMerchant,
  updateMerchantLimitsMdr,
  updateMerchantPriority,
} from './merchants.service'

export const merchantRoutes = new Hono<AppEnv>()

// All routes require authentication
merchantRoutes.use('*', requireAuth)

// GET /api/merchants — List merchants (all roles)
merchantRoutes.get(
  '/',
  zodValidator('query', listMerchantsQuerySchema),
  async (c) => {
    const query = c.req.valid('query' as never) as ListMerchantsQuery
    const result = await listMerchants(query)
    return c.json(result)
  },
)

// GET /api/merchants/:id/overview — Overview tab
merchantRoutes.get('/:id/overview', async (c) => {
  const id = c.req.param('id')
  const result = await getMerchantOverview(id)
  return c.json(result)
})

// GET /api/merchants/:id/form — Form and agreement tab
merchantRoutes.get('/:id/form', async (c) => {
  const id = c.req.param('id')
  const result = await getMerchantForm(id)
  return c.json(result)
})

// GET /api/merchants/:id/history — History tab
merchantRoutes.get('/:id/history', async (c) => {
  const id = c.req.param('id')
  const result = await getMerchantHistory(id)
  return c.json(result)
})

// GET /api/merchants/:id/limits-mdr — Limits & MDR tab
merchantRoutes.get('/:id/limits-mdr', async (c) => {
  const id = c.req.param('id')
  const result = await getMerchantLimits(id)
  return c.json(result)
})

// GET /api/merchants/:id — Merchant header (all roles)
merchantRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const result = await getMerchantHeader(id)
  return c.json(result)
})

// PATCH /api/merchants/:id/limits-mdr — Update per-merchant limits & MDR (super admin, admin)
merchantRoutes.patch(
  '/:id/limits-mdr',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', merchantLimitsMdrSchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as MerchantLimitsMdr
    const result = await updateMerchantLimitsMdr(id, input)
    return c.json(result)
  },
)

// DELETE /api/merchants/:id/limits-mdr — Reset to global limits & MDR (super admin, admin)
merchantRoutes.delete(
  '/:id/limits-mdr',
  requireRoles('super_admin', 'admin'),
  async (c) => {
    const id = c.req.param('id')
    const result = await resetMerchantLimitsMdr(id)
    return c.json(result)
  },
)

// PATCH /api/merchants/:id/terminate — Terminate merchant and close open cases
merchantRoutes.patch(
  '/:id/terminate',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', terminateMerchantSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as TerminateMerchantInput
    const result = await terminateMerchant(id, auth.userId, input)
    return c.json(result)
  },
)

// DELETE /api/merchants/:id/permanent — Delete all merchant DB and Drive data
merchantRoutes.delete(
  '/:id/permanent',
  requireRoles('super_admin'),
  zodValidator('json', permanentlyDeleteMerchantSchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as PermanentlyDeleteMerchantInput
    const result = await permanentlyDeleteMerchant(id, input)
    return c.json(result)
  },
)

// PATCH /api/merchants/:id/priority — Update priority (super admin, admin)
merchantRoutes.patch(
  '/:id/priority',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', updatePrioritySchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as UpdatePriorityInput
    const result = await updateMerchantPriority(id, input)
    return c.json(result)
  },
)

// POST /api/merchants/bulk-terminate — Bulk terminate merchants and close open cases
merchantRoutes.post(
  '/bulk-terminate',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', bulkTerminateMerchantsSchema),
  async (c) => {
    const auth = c.get('auth')
    const input = c.req.valid('json' as never) as BulkTerminateMerchantsInput
    const result = await bulkTerminateMerchants(input.ids, auth.userId, input)
    return c.json(result)
  },
)

// DELETE /api/merchants/:id — Soft delete (admin only)
merchantRoutes.delete('/:id', requireRoles('super_admin'), async (c) => {
  const id = c.req.param('id')
  const result = await softDeleteMerchant(id)
  return c.json(result)
})

// POST /api/merchants/bulk-delete — Bulk soft delete (admin only)
merchantRoutes.post(
  '/bulk-delete',
  requireRoles('super_admin'),
  zodValidator('json', bulkIdsSchema),
  async (c) => {
    const { ids } = c.req.valid('json' as never) as BulkIdsInput
    const result = await bulkSoftDeleteMerchants(ids)
    return c.json(result)
  },
)

// POST /api/merchants/bulk-priority — Bulk priority update (super admin, admin)
merchantRoutes.post(
  '/bulk-priority',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', bulkPrioritySchema),
  async (c) => {
    const { ids, priority, note } = c.req.valid(
      'json' as never,
    ) as BulkPriorityInput
    const result = await bulkUpdatePriority(ids, priority, note)
    return c.json(result)
  },
)
