import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const roleTypeEnum = pgEnum("role_type", [
  "super_admin",
  "admin",
  "supervisor",
  "employee",
]);

export const userStatusEnum = pgEnum("user_status", ["active", "inactive"]);

export const refreshTokenStatusEnum = pgEnum("refresh_token_status", [
  "active",
  "revoked",
  "rotated",
]);

export const accessPolicies = pgTable("access_policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    username: varchar("employee_id", { length: 64 }).notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    roleType: roleTypeEnum("role_type").notNull(),
    status: userStatusEnum("status").default("active").notNull(),
    accessPolicyId: uuid("access_policy_id").references(() => accessPolicies.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    usersEmailIdx: index("users_email_idx").on(table.email),
    usersUsernameIdx: index("users_employee_id_idx").on(table.username),
  }),
);

export const queues = pgTable("queues", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const policyQueues = pgTable(
  "policy_queues",
  {
    policyId: uuid("policy_id")
      .notNull()
      .references(() => accessPolicies.id, { onDelete: "cascade" }),
    queueId: uuid("queue_id")
      .notNull()
      .references(() => queues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    policyQueuesPk: primaryKey({
      columns: [table.policyId, table.queueId],
      name: "policy_queues_pk",
    }),
  }),
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    status: refreshTokenStatusEnum("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedByTokenId: uuid("replaced_by_token_id"),
    userAgent: text("user_agent"),
    ipAddress: varchar("ip_address", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    refreshTokensUserIdIdx: index("refresh_tokens_user_id_idx").on(table.userId),
    refreshTokensExpiresAtIdx: index("refresh_tokens_expires_at_idx").on(table.expiresAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
