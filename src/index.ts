import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { env } from "./config/env";
import { getDb } from "./db/client";
import { errorHandler } from "./middleware/error-handler";
import { authRoutes } from "./modules/auth/auth.routes";
import { merchantFormRoutes } from "./modules/merchants/form.routes";
import { userRoutes } from "./modules/users/users.routes";
import type { AppEnv } from "./types/auth";

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
  })
);

app.onError(errorHandler);

app.get("/", (c) => {
  return c.json({
    name: "Onboarding Portal API",
    status: "ok",
  });
});

app.get("/health/db", async (c) => {
  const result = await getDb().execute(sql`select 1 as ok`);

  return c.json({
    status: "ok",
    db: result[0]?.ok === 1,
  });
});

app.route("/api/auth", authRoutes);
app.route("/api/public", merchantFormRoutes);
app.route("/api/users", userRoutes);

export default {
  port: env.APP_PORT,
  fetch: app.fetch,
};
