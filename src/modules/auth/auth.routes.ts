import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { rateLimiter } from "hono-rate-limiter";

import { env } from "../../config/env";
import { zodValidator } from "../../lib/validators";
import type { AppEnv } from "../../types/auth";
import { loginSchema, registerAdminSchema } from "./auth.schemas";
import {
  login,
  logout,
  refreshSession,
  registerAdmin,
} from "./auth.service";

const REFRESH_COOKIE_NAME = "refresh_token";

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.COOKIE_SECURE,
    path: "/",
    domain: env.COOKIE_DOMAIN,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  };
}

const authRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-6",
  keyGenerator: (c) =>
    c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown",
  handler: (c) => c.json({ error: "Too many attempts. Please try again later." }, 429),
});

export const authRoutes = new Hono<AppEnv>();

authRoutes.use("/login", csrf({ origin: env.CORS_ORIGIN }));
authRoutes.use("/refresh", csrf({ origin: env.CORS_ORIGIN }));
authRoutes.use("/logout", csrf({ origin: env.CORS_ORIGIN }));

authRoutes.use("/login", authRateLimiter);
authRoutes.use("/register-admin", authRateLimiter);

authRoutes.post("/register-admin", zodValidator("json", registerAdminSchema), async (c) => {
  if (!env.ALLOW_ADMIN_REGISTRATION) {
    return c.json({ error: "Admin registration is disabled." }, 403);
  }

  const input = c.req.valid("json");
  const user = await registerAdmin(input);

  return c.json({ user }, 201);
});

authRoutes.post("/login", zodValidator("json", loginSchema), async (c) => {
  const input = c.req.valid("json");
  const session = await login({
    ...input,
    userAgent: c.req.header("user-agent"),
    ipAddress: c.req.header("x-forwarded-for") ?? "",
  });

  const cookieOptions = getCookieOptions();
  setCookie(c, REFRESH_COOKIE_NAME, session.refreshToken, cookieOptions);

  return c.json({
    accessToken: session.accessToken,
    user: session.user,
  });
});

authRoutes.post("/refresh", async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE_NAME);

  if (!refreshToken) {
    return c.json({ error: "Missing refresh token." }, 401);
  }

  const session = await refreshSession({
    refreshToken,
    userAgent: c.req.header("user-agent"),
    ipAddress: c.req.header("x-forwarded-for") ?? "",
  });

  const cookieOptions = getCookieOptions();
  setCookie(c, REFRESH_COOKIE_NAME, session.refreshToken, cookieOptions);

  return c.json({
    accessToken: session.accessToken,
    user: session.user,
  });
});

authRoutes.post("/logout", async (c) => {
  const refreshToken = getCookie(c, REFRESH_COOKIE_NAME);

  if (refreshToken) {
    await logout(refreshToken);
  }

  deleteCookie(c, REFRESH_COOKIE_NAME, getCookieOptions());

  return c.json({ success: true });
});
