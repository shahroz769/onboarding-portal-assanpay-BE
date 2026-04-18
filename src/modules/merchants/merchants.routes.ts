import { Hono } from "hono";

import { requireAuth } from "../../middleware/auth";
import { requireRoles } from "../../middleware/rbac";
import { zodValidator } from "../../lib/validators";
import type { AppEnv } from "../../types/auth";
import {
  bulkIdsSchema,
  bulkPrioritySchema,
  listMerchantsQuerySchema,
  updatePrioritySchema,
  type BulkIdsInput,
  type BulkPriorityInput,
  type ListMerchantsQuery,
  type UpdatePriorityInput,
} from "./merchants.schemas";
import {
  bulkSoftDeleteMerchants,
  bulkUpdatePriority,
  listMerchants,
  softDeleteMerchant,
  updateMerchantPriority,
} from "./merchants.service";

export const merchantRoutes = new Hono<AppEnv>();

// All routes require authentication
merchantRoutes.use("*", requireAuth);

// GET /api/merchants — List merchants (all roles)
merchantRoutes.get(
  "/",
  zodValidator("query", listMerchantsQuerySchema),
  async (c) => {
    const query = c.req.valid("query" as never) as ListMerchantsQuery;
    const result = await listMerchants(query);
    return c.json(result);
  },
);

// PATCH /api/merchants/:id/priority — Update priority (admin, supervisor)
merchantRoutes.patch(
  "/:id/priority",
  requireRoles("admin", "supervisor"),
  zodValidator("json", updatePrioritySchema),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as UpdatePriorityInput;
    const result = await updateMerchantPriority(id, input);
    return c.json(result);
  },
);

// DELETE /api/merchants/:id — Soft delete (admin only)
merchantRoutes.delete(
  "/:id",
  requireRoles("admin"),
  async (c) => {
    const id = c.req.param("id");
    const result = await softDeleteMerchant(id);
    return c.json(result);
  },
);

// POST /api/merchants/bulk-delete — Bulk soft delete (admin only)
merchantRoutes.post(
  "/bulk-delete",
  requireRoles("admin"),
  zodValidator("json", bulkIdsSchema),
  async (c) => {
    const { ids } = c.req.valid("json" as never) as BulkIdsInput;
    const result = await bulkSoftDeleteMerchants(ids);
    return c.json(result);
  },
);

// POST /api/merchants/bulk-priority — Bulk priority update (admin, supervisor)
merchantRoutes.post(
  "/bulk-priority",
  requireRoles("admin", "supervisor"),
  zodValidator("json", bulkPrioritySchema),
  async (c) => {
    const { ids, priority } = c.req.valid("json" as never) as BulkPriorityInput;
    const result = await bulkUpdatePriority(ids, priority);
    return c.json(result);
  },
);
