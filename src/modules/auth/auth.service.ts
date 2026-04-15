import { and, eq, gt, isNull, or } from "drizzle-orm";

import { env } from "../../config/env";
import { getDb } from "../../db/client";
import { refreshTokens, users } from "../../db/schema";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../lib/auth";
import { AppError } from "../../lib/errors";
import { hashToken } from "../../lib/security";
import type { RoleType, SessionUser } from "../../types/auth";

const roleCreationRules: Record<RoleType, RoleType[]> = {
  admin: ["supervisor", "employee"],
  supervisor: ["employee"],
  employee: [],
};

function getRefreshTokenExpiresAt() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + env.REFRESH_TOKEN_TTL_DAYS);
  return expiresAt;
}

function sanitizeUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    roleType: user.roleType,
    status: user.status,
    accessPolicyId: user.accessPolicyId,
    createdByUserId: user.createdByUserId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function assertUniqueUser(input: { email: string; username: string }) {
  const existingUser = await getDb().query.users.findFirst({
    where: and(
      or(eq(users.email, input.email), eq(users.username, input.username)),
      isNull(users.deletedAt),
    ),
  });

  if (!existingUser) {
    return;
  }

  if (existingUser.email === input.email) {
    throw new AppError(409, "Email is already in use.");
  }

  throw new AppError(409, "Username is already in use.");
}

async function issueSession(params: {
  user: typeof users.$inferSelect;
  userAgent?: string;
  ipAddress?: string;
}) {
  const sessionId = crypto.randomUUID();
  const refreshToken = await signRefreshToken({
    sub: params.user.id,
    sessionId,
  });
  const refreshTokenHash = await hashToken(refreshToken);

  await getDb().insert(refreshTokens).values({
    id: sessionId,
    userId: params.user.id,
    tokenHash: refreshTokenHash,
    expiresAt: getRefreshTokenExpiresAt(),
    userAgent: params.userAgent,
    ipAddress: params.ipAddress,
  });

  const accessToken = await signAccessToken({
    sub: params.user.id,
    email: params.user.email,
    roleType: params.user.roleType,
  });

  return {
    accessToken,
    refreshToken,
    user: sanitizeUser(params.user),
  };
}

export async function registerAdmin(input: {
  name: string;
  email: string;
  username: string;
  password: string;
}) {
  if (!env.ALLOW_ADMIN_REGISTRATION) {
    throw new AppError(403, "Admin registration is disabled.");
  }

  await assertUniqueUser({
    email: input.email,
    username: input.username,
  });

  const passwordHash = await Bun.password.hash(input.password);

  const [createdUser] = await getDb()
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      username: input.username,
      passwordHash,
      roleType: "admin",
      status: "active",
    })
    .returning();

  return sanitizeUser(createdUser);
}

export async function login(input: {
  identifier: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
}) {
  const user = await getDb().query.users.findFirst({
    where: and(
      or(eq(users.email, input.identifier), eq(users.username, input.identifier)),
      eq(users.status, "active"),
      isNull(users.deletedAt),
    ),
  });

  if (!user) {
    throw new AppError(401, "Invalid email or password.");
  }

  const passwordMatches = await Bun.password.verify(input.password, user.passwordHash);

  if (!passwordMatches) {
    throw new AppError(401, "Invalid email or password.");
  }

  await getDb()
    .update(users)
    .set({
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return issueSession({
    user,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });
}

export async function refreshSession(input: {
  refreshToken: string;
  userAgent?: string;
  ipAddress?: string;
}) {
  const payload = await verifyRefreshToken(input.refreshToken).catch(() => {
    throw new AppError(401, "Invalid refresh token.");
  });

  const hashedToken = await hashToken(input.refreshToken);

  const tokenRecord = await getDb().query.refreshTokens.findFirst({
    where: and(
      eq(refreshTokens.id, payload.sessionId),
      eq(refreshTokens.tokenHash, hashedToken),
      eq(refreshTokens.status, "active"),
      gt(refreshTokens.expiresAt, new Date()),
    ),
  });

  if (!tokenRecord) {
    throw new AppError(401, "Refresh token is expired or revoked.");
  }

  const user = await getDb().query.users.findFirst({
    where: and(
      eq(users.id, payload.userId),
      eq(users.status, "active"),
      isNull(users.deletedAt),
    ),
  });

  if (!user) {
    throw new AppError(401, "User is not available.");
  }

  const nextSessionId = crypto.randomUUID();
  const nextRefreshToken = await signRefreshToken({
    sub: user.id,
    sessionId: nextSessionId,
  });
  const nextRefreshTokenHash = await hashToken(nextRefreshToken);

  await getDb().transaction(async (tx) => {
    await tx
      .update(refreshTokens)
      .set({
        status: "rotated",
        revokedAt: new Date(),
        replacedByTokenId: nextSessionId,
      })
      .where(eq(refreshTokens.id, tokenRecord.id));

    await tx.insert(refreshTokens).values({
      id: nextSessionId,
      userId: user.id,
      tokenHash: nextRefreshTokenHash,
      expiresAt: getRefreshTokenExpiresAt(),
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });
  });

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    roleType: user.roleType,
  });

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    user: sanitizeUser(user),
  };
}

export async function logout(refreshToken: string) {
  const payload = await verifyRefreshToken(refreshToken).catch(() => null);

  if (!payload) {
    return;
  }

  const hashedToken = await hashToken(refreshToken);

  await getDb()
    .update(refreshTokens)
    .set({
      status: "revoked",
      revokedAt: new Date(),
    })
    .where(
      and(
        eq(refreshTokens.id, payload.sessionId),
        eq(refreshTokens.tokenHash, hashedToken),
      ),
    );
}

export function canCreateRole(actorRole: RoleType, targetRole: RoleType) {
  return roleCreationRules[actorRole].includes(targetRole);
}

export async function createManagedUser(
  actor: SessionUser,
  input: {
    name: string;
    email: string;
    username: string;
    password: string;
    roleType: RoleType;
    accessPolicyId?: string;
  },
) {
  if (!canCreateRole(actor.roleType, input.roleType)) {
    throw new AppError(403, "You cannot create a user with this role.");
  }

  await assertUniqueUser({
    email: input.email,
    username: input.username,
  });

  const passwordHash = await Bun.password.hash(input.password);

  const [createdUser] = await getDb()
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      username: input.username,
      passwordHash,
      roleType: input.roleType,
      status: "active",
      accessPolicyId: input.accessPolicyId,
      createdByUserId: actor.userId,
    })
    .returning();

  return sanitizeUser(createdUser);
}

export async function revokeAllUserSessions(userId: string) {
  await getDb()
    .update(refreshTokens)
    .set({
      status: "revoked",
      revokedAt: new Date(),
    })
    .where(eq(refreshTokens.userId, userId));
}
