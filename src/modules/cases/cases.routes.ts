import { Hono } from "hono";

import { requireAuth } from "../../middleware/auth";
import { requireRoles } from "../../middleware/rbac";
import { zodValidator } from "../../lib/validators";
import type { AppEnv } from "../../types/auth";
import {
  assignCaseSchema,
  bulkAssignCaseSchema,
  closeUnsuccessfulSchema,
  createCaseSchema,
  createCommentSchema,
  listCasesQuerySchema,
  saveFieldReviewsSchema,
  updateCasePrioritySchema,
  updateCaseStatusSchema,
  type AssignCaseInput,
  type BulkAssignCaseInput,
  type CloseUnsuccessfulInput,
  type CreateCaseInput,
  type CreateCommentInput,
  type ListCasesQuery,
  type SaveFieldReviewsInput,
  type UpdateCasePriorityInput,
  type UpdateCaseStatusInput,
} from "./cases.schemas";
import {
  advanceStage,
  assignCase,
  bulkAssignCases,
  closeUnsuccessful,
  createCase,
  createCaseComment,
  getCaseDetail,
  listCaseComments,
  listCaseHistory,
  listCaseOwners,
  listCases,
  saveFieldReviews,
  takeOwnership,
  updateCasePriority,
  updateCaseStatus,
  sendForResubmission,
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
    const auth = c.get("auth");
    const input = c.req.valid("json" as never) as BulkAssignCaseInput;
    const result = await bulkAssignCases(input.ids, input.ownerId, auth.userId);
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
    const auth = c.get("auth");
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as AssignCaseInput;
    const result = await assignCase(id, input.ownerId, auth.userId);
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

// GET /api/cases/:id — Get case detail (all authenticated)
caseRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const result = await getCaseDetail(id);
  return c.json(result);
});

// PATCH /api/cases/:id/take-ownership — Take ownership of a case
caseRoutes.patch("/:id/take-ownership", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const result = await takeOwnership(id, auth.userId);
  return c.json(result);
});

// PATCH /api/cases/:id/advance-stage — Advance case to next stage
caseRoutes.patch("/:id/advance-stage", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const result = await advanceStage(id, auth.userId);
  return c.json(result);
});

// PUT /api/cases/:id/field-reviews — Save field reviews
caseRoutes.put(
  "/:id/field-reviews",
  zodValidator("json", saveFieldReviewsSchema),
  async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as SaveFieldReviewsInput;
    const result = await saveFieldReviews(id, auth.userId, input);
    return c.json(result);
  },
);

// PATCH /api/cases/:id/close-unsuccessful — Close case as unsuccessful
caseRoutes.patch(
  "/:id/close-unsuccessful",
  zodValidator("json", closeUnsuccessfulSchema),
  async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as CloseUnsuccessfulInput;
    const result = await closeUnsuccessful(id, auth.userId, input);
    return c.json(result);
  },
);

// POST /api/cases/:id/send-for-resubmission — Email client + move to awaiting_client
caseRoutes.post("/:id/send-for-resubmission", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const result = await sendForResubmission(id, auth.userId);
  return c.json(result);
});

// GET /api/cases/:id/comments — List comments for a case
caseRoutes.get("/:id/comments", async (c) => {
  const id = c.req.param("id");
  const result = await listCaseComments(id);
  return c.json(result);
});

// POST /api/cases/:id/comments — Create a comment on a case
caseRoutes.post(
  "/:id/comments",
  zodValidator("json", createCommentSchema),
  async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const input = c.req.valid("json" as never) as CreateCommentInput;
    const result = await createCaseComment(id, auth.userId, input);
    return c.json(result, 201);
  },
);

// GET /api/cases/:id/history — Get case history timeline
caseRoutes.get("/:id/history", async (c) => {
  const id = c.req.param("id");
  const result = await listCaseHistory(id);
  return c.json(result);
});
