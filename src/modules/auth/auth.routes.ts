import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";

import { env } from "../../config/env";
import { parseJsonBody } from "../../lib/http";
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

function getRequestDebugMeta(c: Parameters<typeof getCookie>[0]) {
  return {
    origin: c.req.header("origin") ?? null,
    referer: c.req.header("referer") ?? null,
    host: c.req.header("host") ?? null,
    cookieHeader: c.req.header("cookie") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/register-admin", async (c) => {
  if (!env.ALLOW_ADMIN_REGISTRATION) {
    return c.json({ error: "Admin registration is disabled." }, 403);
  }

  const input = await parseJsonBody(c.req.raw, registerAdminSchema);
  const user = await registerAdmin(input);

  return c.json({ user }, 201);
});

authRoutes.post("/login", async (c) => {
  const input = await parseJsonBody(c.req.raw, loginSchema);
  const session = await login({
    ...input,
    userAgent: c.req.header("user-agent"),
    ipAddress: c.req.header("x-forwarded-for") ?? "",
  });

  const cookieOptions = getCookieOptions();
  console.info("[auth.login] issuing refresh cookie", {
    ...getRequestDebugMeta(c),
    cookieName: REFRESH_COOKIE_NAME,
    cookieOptions,
    refreshTokenLength: session.refreshToken.length,
    userId: session.user.id,
  });

  setCookie(c, REFRESH_COOKIE_NAME, session.refreshToken, cookieOptions);

  return c.json({
    accessToken: session.accessToken,
    user: session.user,
  });
});

authRoutes.post("/refresh", async (c) => {
  console.info("[auth.refresh] incoming request", {
    ...getRequestDebugMeta(c),
    parsedRefreshCookiePresent: Boolean(getCookie(c, REFRESH_COOKIE_NAME)),
  });

  const refreshToken = getCookie(c, REFRESH_COOKIE_NAME);

  if (!refreshToken) {
    console.warn("[auth.refresh] missing refresh cookie", {
      ...getRequestDebugMeta(c),
    });
    return c.json({ error: "Missing refresh token." }, 401);
  }

  const session = await refreshSession({
    refreshToken,
    userAgent: c.req.header("user-agent"),
    ipAddress: c.req.header("x-forwarded-for") ?? "",
  });

  const cookieOptions = getCookieOptions();
  console.info("[auth.refresh] rotating refresh cookie", {
    ...getRequestDebugMeta(c),
    cookieName: REFRESH_COOKIE_NAME,
    cookieOptions,
    refreshTokenLength: session.refreshToken.length,
    userId: session.user.id,
  });

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

  console.info("[auth.logout] clearing refresh cookie", {
    ...getRequestDebugMeta(c),
    parsedRefreshCookiePresent: Boolean(refreshToken),
    cookieName: REFRESH_COOKIE_NAME,
    cookieOptions: getCookieOptions(),
  });

  deleteCookie(c, REFRESH_COOKIE_NAME, getCookieOptions());

  return c.json({ success: true });
});
