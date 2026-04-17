import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { getDb } from "../db/client";
import { users } from "../db/schema";
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

  const user = await getDb().query.users.findFirst({
    where: and(
      eq(users.id, session.userId),
      eq(users.status, "active"),
      eq(users.sessionVersion, session.sessionVersion),
      isNull(users.deletedAt),
    ),
  });

  if (!user) {
    throw new AppError(401, "Access token is expired or revoked.");
  }

  c.set("auth", session);

  await next();
});
