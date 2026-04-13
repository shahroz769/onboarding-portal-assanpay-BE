import { Hono } from "hono";

import { parseJsonBody } from "../../lib/http";
import { requireAuth } from "../../middleware/auth";
import { requireRoles } from "../../middleware/rbac";
import type { AppEnv } from "../../types/auth";
import { createUserSchema } from "../auth/auth.schemas";
import { updateUserSchema } from "./users.schemas";
import {
  createUser,
  deactivateUser,
  getUserById,
  listUsers,
  updateUser,
} from "./users.service";

export const userRoutes = new Hono<AppEnv>();

userRoutes.use("*", requireAuth);

userRoutes.get("/", requireRoles("super_admin", "admin", "supervisor"), async (c) => {
  const users = await listUsers();
  return c.json({ users });
});

userRoutes.get(
  "/:id",
  requireRoles("super_admin", "admin", "supervisor"),
  async (c) => {
    const user = await getUserById(c.req.param("id"));
    return c.json({ user });
  },
);

userRoutes.post(
  "/",
  requireRoles("super_admin", "admin", "supervisor"),
  async (c) => {
    const input = await parseJsonBody(c.req.raw, createUserSchema);
    const user = await createUser(c.get("auth"), input);
    return c.json({ user }, 201);
  },
);

userRoutes.patch(
  "/:id",
  requireRoles("super_admin", "admin", "supervisor"),
  async (c) => {
    const input = await parseJsonBody(c.req.raw, updateUserSchema);
    const user = await updateUser(c.get("auth"), c.req.param("id"), input);
    return c.json({ user });
  },
);

userRoutes.delete(
  "/:id",
  requireRoles("super_admin", "admin"),
  async (c) => {
    const user = await deactivateUser(c.get("auth"), c.req.param("id"));
    return c.json({ user });
  },
);
