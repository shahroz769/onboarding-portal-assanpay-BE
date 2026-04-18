import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { refreshTokens, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import type { RoleType, SessionUser } from "../../types/auth";
import {
  canCreateRole,
  createManagedUser,
  revokeAllUserSessions,
} from "../auth/auth.service";

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

async function assertUsernameAvailable(username: string, userId: string) {
  const existingUser = await getDb().query.users.findFirst({
    where: and(
      eq(users.username, username),
      ne(users.id, userId),
      isNull(users.deletedAt),
    ),
  });

  if (existingUser) {
    throw new AppError(409, "Username is already in use.");
  }
}

export async function listUsers() {
  const result = await getDb().query.users.findMany({
    where: isNull(users.deletedAt),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });

  return result.map(sanitizeUser);
}

export async function getUserById(id: string) {
  const user = await getDb().query.users.findFirst({
    where: and(eq(users.id, id), isNull(users.deletedAt)),
  });

  if (!user) {
    throw new AppError(404, "User not found.");
  }

  return sanitizeUser(user);
}

export { createManagedUser as createUser };

export async function updateUser(
  actor: SessionUser,
  userId: string,
  input: {
    name?: string;
    username?: string;
    roleType?: RoleType;
    status?: "active" | "inactive";
    accessPolicyId?: string | null;
    password?: string;
  },
) {
  const existingUser = await getDb().query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
  });

  if (!existingUser) {
    throw new AppError(404, "User not found.");
  }

  if (input.roleType && !canCreateRole(actor.roleType, input.roleType)) {
    throw new AppError(403, "You cannot assign this role.");
  }

  if (input.username) {
    await assertUsernameAvailable(input.username, userId);
  }

  const updateData: Partial<typeof users.$inferInsert> = {
    name: input.name,
    username: input.username,
    roleType: input.roleType,
    status: input.status,
    accessPolicyId: input.accessPolicyId,
    updatedAt: new Date(),
  };

  if (input.password) {
    updateData.passwordHash = await Bun.password.hash(input.password);
  }

  const needsSessionRevocation =
    input.password ||
    input.status === "inactive" ||
    input.roleType ||
    input.accessPolicyId !== undefined;

  if (needsSessionRevocation) {
    return getDb().transaction(async (tx) => {
      const [updatedUser] = await tx
        .update(users)
        .set(updateData)
        .where(eq(users.id, userId))
        .returning();

      await tx
        .update(refreshTokens)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(refreshTokens.userId, userId));

      await tx
        .update(users)
        .set({
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return sanitizeUser(updatedUser);
    });
  }

  const [updatedUser] = await getDb()
    .update(users)
    .set(updateData)
    .where(eq(users.id, userId))
    .returning();

  return sanitizeUser(updatedUser);
}

export async function deactivateUser(actor: SessionUser, userId: string) {
  if (actor.userId === userId) {
    throw new AppError(400, "You cannot delete your own account.");
  }

  const existingUser = await getDb().query.users.findFirst({
    where: and(eq(users.id, userId), isNull(users.deletedAt)),
  });

  if (!existingUser) {
    throw new AppError(404, "User not found.");
  }

  return getDb().transaction(async (tx) => {
    const [updatedUser] = await tx
      .update(users)
      .set({
        status: "inactive",
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    await tx
      .update(refreshTokens)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(refreshTokens.userId, userId));

    await tx
      .update(users)
      .set({
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return sanitizeUser(updatedUser);
  });
}
