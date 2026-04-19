import { Hono } from "hono";

import { requireAuth } from "../../middleware/auth";
import { requireRoles } from "../../middleware/rbac";
import { zodValidator } from "../../lib/validators";
import type { AppEnv } from "../../types/auth";
import { createQueueSchema, type CreateQueueInput } from "./queues.schemas";
import { createQueue, listQueues } from "./queues.service";

export const queueRoutes = new Hono<AppEnv>();

// All routes require authentication
queueRoutes.use("*", requireAuth);

// GET /api/queues — List all queues (all authenticated users)
queueRoutes.get("/", async (c) => {
  const result = await listQueues();
  return c.json(result);
});

// POST /api/queues — Create queue (admin only)
queueRoutes.post(
  "/",
  requireRoles("admin"),
  zodValidator("json", createQueueSchema),
  async (c) => {
    const input = c.req.valid("json" as never) as CreateQueueInput;
    const result = await createQueue(input);
    return c.json(result, 201);
  },
);
