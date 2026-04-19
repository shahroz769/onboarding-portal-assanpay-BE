import { Hono } from "hono";

import { requireAuth } from "../../middleware/auth";
import { requireRoles } from "../../middleware/rbac";
import { zodValidator } from "../../lib/validators";
import type { AppEnv } from "../../types/auth";
import {
  assignCaseSchema,
  bulkAssignCaseSchema,
  createCaseSchema,
  listCasesQuerySchema,
  updateCasePrioritySchema,
  updateCaseStatusSchema,
  type AssignCaseInput,
  type BulkAssignCaseInput,
  type CreateCaseInput,
  type ListCasesQuery,
  type UpdateCasePriorityInput,
  type UpdateCaseStatusInput,
} from "./cases.schemas";
import {
  assignCase,
  bulkAssignCases,
  createCase,
  listCaseOwners,
  listCases,
  updateCasePriority,
  updateCaseStatus,
} from "./cases.service";

export const caseRoutes = new Hono<AppEnv>();

// All routes require authentication
caseRoutes.use("*", requireAuth);

// GET /api/cases/owners — Distinct case owners
caseRoutes.get("/owners", async (c) => {
  const owners = await listCaseOwners();
  return c.json(owners);
});

// GET /api/cases — List cases (all authenticated users)
caseRoutes.get(
  "/",
  zodValidator("query", listCasesQuerySchema),
  async (c) => {
    const query = c.req.valid("query" as never) as ListCasesQuery;
    const result = await listCases(query);
    return c.json(result);
  },
);

// POST /api/cases — Create case (admin, supervisor)
caseRoutes.post(
  "/",
  requireRoles("admin", "supervisor"),
  zodValidator("json", createCaseSchema),
  async (c) => {
    const input = c.req.valid("json" as never) as CreateCaseInput;
    const result = await createCase(input);
    return c.json(result, 201);
  },
);

// POST /api/cases/bulk-assign — Bulk assign owner (admin, supervisor)
caseRoutes.post(
  "/bulk-assign",
  requireRoles("admin", "supervisor"),
  zodValidator("json", bulkAssignCaseSchema),
  async (c) => {
    const input = c.req.valid("json" as never) as BulkAssignCaseInput;
    const result = await bulkAssignCases(input.ids, input.ownerId);
    return c.json(result);
  },
);

// PATCH /api/cases/:id/status — Update case status (admin, supervisor)
caseRoutes.patch(
  "/:id/status",
  requireRoles("admin", "supervisor"),
  zodValidator("json", updateCaseStatusSchema),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as UpdateCaseStatusInput;
    const result = await updateCaseStatus(id, input);
    return c.json(result);
  },
);

// PATCH /api/cases/:id/assign — Assign case owner (admin, supervisor)
caseRoutes.patch(
  "/:id/assign",
  requireRoles("admin", "supervisor"),
  zodValidator("json", assignCaseSchema),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as AssignCaseInput;
    const result = await assignCase(id, input.ownerId);
    return c.json(result);
  },
);

// PATCH /api/cases/:id/priority — Update case priority (admin, supervisor)
caseRoutes.patch(
  "/:id/priority",
  requireRoles("admin", "supervisor"),
  zodValidator("json", updateCasePrioritySchema),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as UpdateCasePriorityInput;
    const result = await updateCasePriority(id, input.priority);
    return c.json(result);
  },
);
