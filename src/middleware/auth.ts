import { createMiddleware } from "hono/factory";

import { verifyAccessToken } from "../lib/auth";
import { AppError } from "../lib/errors";
import type { AppEnv } from "../types/auth";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(401, "Missing bearer token.");
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    throw new AppError(401, "Missing bearer token.");
  }

  const session = await verifyAccessToken(token).catch(() => {
    throw new AppError(401, "Invalid access token.");
  });

  c.set("auth", session);

  await next();
});
