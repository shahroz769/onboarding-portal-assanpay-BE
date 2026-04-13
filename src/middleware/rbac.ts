import { createMiddleware } from "hono/factory";

import { AppError } from "../lib/errors";
import type { AppEnv, RoleType } from "../types/auth";

export function requireRoles(...roles: RoleType[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get("auth");

    if (!roles.includes(auth.roleType)) {
      throw new AppError(403, "Insufficient permissions.");
    }

    await next();
  });
}
