import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const roleTypeEnum = pgEnum("role_type", [
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

export const merchantTypeEnum = pgEnum("merchant_type", [
  "sole_proprietorship",
  "private_limited_company",
  "partnership",
  "limited_liability_partnership",
  "ngo_npo_charity",
  "trust_society_association",
]);

export const merchantStatusEnum = pgEnum("merchant_status", [
  "form_submitted",
  "documents_review",
  "sub_merchant",
  "agreement",
  "testing",
  "live",
  "suspended",
]);

export const kinRelationEnum = pgEnum("kin_relation", [
  "mother",
  "father",
  "brother",
  "sister",
  "wife",
  "son",
  "daughter",
]);

export const websiteCmsEnum = pgEnum("website_cms", [
  "wordpress",
  "shopify",
  "custom_website",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "pending",
  "approved",
  "rejected",
]);

export const priorityEnum = pgEnum("priority", ["normal", "high"]);

export const businessScopeEnum = pgEnum("business_scope", [
  "local",
  "international",
]);

export const merchantDocumentTypeEnum = pgEnum("merchant_document_type", [
  "owner_cnic_front",
  "owner_cnic_back",
  "next_of_kin_cnic_front",
  "next_of_kin_cnic_back",
  "utility_bill",
  "company_ntn",
  "authority_letter",
  "taxpayer_registration_certificate",
  "company_incorporation_certificate",
  "memorandum_articles",
  "form_ii",
  "form_a",
  "board_resolution",
  "certificate_of_commencement",
  "partnership_deed",
  "form_c",
  "llp_form_iii",
  "annual_audited_accounts",
  "other_entity_certification",
  "secp_section_42_license",
  "risk_assessment_documents",
  "by_laws_rules_regulations",
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
    sessionVersion: integer("session_version").default(0).notNull(),
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

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    merchantNumber: serial("merchant_number").notNull().unique(),
    submitterEmail: varchar("submitter_email", { length: 255 }).notNull(),
    ownerFullName: varchar("owner_full_name", { length: 160 }).notNull(),
    ownerPhone: varchar("owner_phone", { length: 32 }).notNull(),
    businessName: varchar("business_name", { length: 200 }).notNull(),
    businessPhone: varchar("business_phone", { length: 32 }).notNull(),
    businessEmail: varchar("business_email", { length: 255 }).notNull(),
    businessAddress: text("business_address").notNull(),
    businessWebsite: text("business_website").notNull(),
    websiteCms: websiteCmsEnum("website_cms").notNull(),
    businessDescription: text("business_description").notNull(),
    businessRegistrationDate: date("business_registration_date", {
      mode: "string",
    }).notNull(),
    businessNature: varchar("business_nature", { length: 160 }).notNull(),
    merchantType: merchantTypeEnum("merchant_type").notNull(),
    estimatedMonthlyTransactions: integer("estimated_monthly_transactions").notNull(),
    estimatedMonthlyVolume: numeric("estimated_monthly_volume", {
      precision: 14,
      scale: 2,
    }).notNull(),
    accountTitle: varchar("account_title", { length: 200 }).notNull(),
    bankName: varchar("bank_name", { length: 160 }).notNull(),
    branchName: varchar("branch_name", { length: 160 }).notNull(),
    accountNumberIban: varchar("account_number_iban", { length: 64 }).notNull(),
    swiftCode: varchar("swift_code", { length: 64 }),
    nextOfKinRelation: kinRelationEnum("next_of_kin_relation").notNull(),
    status: merchantStatusEnum("status").default("form_submitted").notNull(),
    onboardingStage: merchantStatusEnum("onboarding_stage")
      .default("form_submitted")
      .notNull(),
    priority: priorityEnum("priority").default("normal").notNull(),
    priorityNote: varchar("priority_note", { length: 500 }),
    businessScope: businessScopeEnum("business_scope").default("local").notNull(),
    currency: varchar("currency", { length: 8 }).default("PKR").notNull(),
    liveAt: timestamp("live_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    merchantsSubmitterEmailIdx: index("merchants_submitter_email_idx").on(table.submitterEmail),
    merchantsBusinessEmailIdx: index("merchants_business_email_idx").on(table.businessEmail),
    merchantsBusinessNameIdx: index("merchants_business_name_idx").on(table.businessName),
    merchantsStatusIdx: index("merchants_status_idx").on(table.status),
    merchantsNumberIdx: index("merchants_number_idx").on(table.merchantNumber),
    merchantsPriorityIdx: index("merchants_priority_idx").on(table.priority),
  }),
);

export const merchantDocuments = pgTable(
  "merchant_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    documentType: merchantDocumentTypeEnum("document_type").notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    googleDriveFileId: varchar("google_drive_file_id", { length: 255 }).notNull(),
    googleDriveWebViewLink: text("google_drive_web_view_link").notNull(),
    googleDriveDownloadLink: text("google_drive_download_link"),
    googleDriveFolderId: varchar("google_drive_folder_id", { length: 255 }).notNull(),
    status: documentStatusEnum("status").default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    merchantDocumentsMerchantIdIdx: index("merchant_documents_merchant_id_idx").on(
      table.merchantId,
    ),
    merchantDocumentsTypeIdx: index("merchant_documents_type_idx").on(table.documentType),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type MerchantDocument = typeof merchantDocuments.$inferSelect;
export type NewMerchantDocument = typeof merchantDocuments.$inferInsert;
