import { SignJWT, jwtVerify } from "jose";

import { env } from "../config/env";
import type { RoleType, SessionUser } from "../types/auth";

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

function getAccessExpiration() {
  return `${env.ACCESS_TOKEN_TTL_MINUTES}m`;
}

function getRefreshExpiration() {
  return `${env.REFRESH_TOKEN_TTL_DAYS}d`;
}

export async function signAccessToken(payload: {
  sub: string;
  roleType: RoleType;
  email: string;
}) {
  return new SignJWT({
    roleType: payload.roleType,
    email: payload.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(getAccessExpiration())
    .sign(accessSecret);
}

export async function signRefreshToken(payload: {
  sub: string;
  sessionId: string;
}) {
  return new SignJWT({
    sessionId: payload.sessionId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(getRefreshExpiration())
    .sign(refreshSecret);
}

export async function verifyAccessToken(token: string): Promise<SessionUser> {
  const { payload } = await jwtVerify(token, accessSecret);

  return {
    userId: String(payload.sub),
    email: String(payload.email),
    roleType: payload.roleType as RoleType,
  };
}

export async function verifyRefreshToken(token: string) {
  const { payload } = await jwtVerify(token, refreshSecret);

  return {
    userId: String(payload.sub),
    sessionId: String(payload.sessionId),
  };
}
