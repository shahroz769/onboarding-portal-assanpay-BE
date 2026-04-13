import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";

import { env } from "../../config/env";
import { parseJsonBody } from "../../lib/http";
import type { AppEnv } from "../../types/auth";
import { loginSchema, registerSchema } from "./auth.schemas";
import {
  login,
  logout,
  refreshSession,
  registerInitialSuperAdmin,
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

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/register", async (c) => {
  const input = await parseJsonBody(c.req.raw, registerSchema);
  const user = await registerInitialSuperAdmin(input);

  return c.json({ user }, 201);
});

authRoutes.post("/login", async (c) => {
  const input = await parseJsonBody(c.req.raw, loginSchema);
  const session = await login({
    ...input,
    userAgent: c.req.header("user-agent"),
    ipAddress: c.req.header("x-forwarded-for") ?? "",
  });

  setCookie(c, REFRESH_COOKIE_NAME, session.refreshToken, getCookieOptions());

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

  setCookie(c, REFRESH_COOKIE_NAME, session.refreshToken, getCookieOptions());

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
