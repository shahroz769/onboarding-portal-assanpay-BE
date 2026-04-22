import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
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

export const caseStatusEnum = pgEnum("case_status", [
  "new",
  "working",
  "pending",
  "qc",
  "error",
  "closed",
  "awaiting_client",
]);

export const queues = pgTable("queues", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 120 }).notNull().unique(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  prefix: varchar("prefix", { length: 4 }).notNull().unique(),
  qcEnabled: boolean("qc_enabled").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const stageCategoryEnum = pgEnum("stage_category", [
  "new",
  "in_progress",
  "qc",
  "error",
  "closed",
]);

export const queueStages = pgTable(
  "queue_stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    queueId: uuid("queue_id")
      .notNull()
      .references(() => queues.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    order: integer("order").notNull(),
    category: stageCategoryEnum("category").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    queueStagesQueueIdIdx: index("queue_stages_queue_id_idx").on(table.queueId),
    queueStagesQueueSlugUniq: uniqueIndex("queue_stages_queue_slug_uniq").on(
      table.queueId,
      table.slug,
    ),
    queueStagesQueueOrderUniq: uniqueIndex("queue_stages_queue_order_uniq").on(
      table.queueId,
      table.order,
    ),
  }),
);

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

export const queueCaseSequences = pgTable("queue_case_sequences", {
  queueId: uuid("queue_id")
    .primaryKey()
    .references(() => queues.id, { onDelete: "cascade" }),
  lastNumber: integer("last_number").default(0).notNull(),
});

export const caseCloseOutcomeEnum = pgEnum("case_close_outcome", [
  "successful",
  "unsuccessful",
]);

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseNumber: varchar("case_number", { length: 20 }).notNull().unique(),
    queueId: uuid("queue_id")
      .notNull()
      .references(() => queues.id, { onDelete: "restrict" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    currentStageId: uuid("current_stage_id").references(() => queueStages.id, {
      onDelete: "set null",
    }),
    status: caseStatusEnum("status").default("new").notNull(),
    priority: priorityEnum("priority").default("normal").notNull(),
    closeOutcome: caseCloseOutcomeEnum("close_outcome"),
    closeReason: text("close_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    casesQueueIdIdx: index("cases_queue_id_idx").on(table.queueId),
    casesMerchantIdIdx: index("cases_merchant_id_idx").on(table.merchantId),
    casesStatusIdx: index("cases_status_idx").on(table.status),
    casesCaseNumberIdx: index("cases_case_number_idx").on(table.caseNumber),
    casesOwnerIdIdx: index("cases_owner_id_idx").on(table.ownerId),
    casesCurrentStageIdIdx: index("cases_current_stage_id_idx").on(table.currentStageId),
  }),
);

export const fieldReviewStatusEnum = pgEnum("field_review_status", [
  "pending",
  "approved",
  "rejected",
]);

export const caseFieldReviews = pgTable(
  "case_field_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fieldName: varchar("field_name", { length: 120 }).notNull(),
    status: fieldReviewStatusEnum("status").default("pending").notNull(),
    remarks: text("remarks"),
    reviewedBy: uuid("reviewed_by")
      .notNull()
      .references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resubmittedAt: timestamp("resubmitted_at", { withTimezone: true }),
  },
  (table) => ({
    caseFieldReviewsCaseIdIdx: index("case_field_reviews_case_id_idx").on(table.caseId),
    caseFieldReviewsReviewedByIdx: index("case_field_reviews_reviewed_by_idx").on(
      table.reviewedBy,
    ),
    caseFieldReviewsCaseFieldUniq: uniqueIndex("case_field_reviews_case_field_uniq").on(
      table.caseId,
      table.fieldName,
    ),
  }),
);

export const caseComments = pgTable(
  "case_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "set null" }),
    content: text("content").notNull(),
    parentId: uuid("parent_id"),
    mentions: text("mentions").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    caseCommentsCaseIdIdx: index("case_comments_case_id_idx").on(table.caseId),
    caseCommentsAuthorIdIdx: index("case_comments_author_id_idx").on(table.authorId),
    caseCommentsParentIdIdx: index("case_comments_parent_id_idx").on(table.parentId),
  }),
);

export const caseHistory = pgTable(
  "case_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 64 }).notNull(),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    caseHistoryCaseIdIdx: index("case_history_case_id_idx").on(table.caseId),
    caseHistoryCreatedAtIdx: index("case_history_created_at_idx").on(table.createdAt),
  }),
);

export const notificationTypeEnum = pgEnum("notification_type", [
  "case_assigned",
  "case_unassigned",
  "comment_mention",
  "comment_reply",
  "comment_thread",
  "case_resubmitted",
]);

export const emailLogStatusEnum = pgEnum("email_log_status", [
  "queued",
  "sent",
  "failed",
]);

export const caseResubmissionTokens = pgTable(
  "case_resubmission_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 86 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseResubmissionTokensCaseIdIdx: index(
      "case_resubmission_tokens_case_id_idx",
    ).on(table.caseId),
  }),
);

export const emailLog = pgTable(
  "email_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    toEmail: varchar("to_email", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 500 }).notNull(),
    template: varchar("template", { length: 120 }).notNull(),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    merchantId: uuid("merchant_id").references(() => merchants.id, {
      onDelete: "set null",
    }),
    resendId: varchar("resend_id", { length: 255 }),
    status: emailLogStatusEnum("status").default("queued").notNull(),
    errorMsg: text("error_msg"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    emailLogCaseIdIdx: index("email_log_case_id_idx").on(table.caseId),
    emailLogStatusIdx: index("email_log_status_idx").on(table.status),
    emailLogCreatedAtIdx: index("email_log_created_at_idx").on(table.createdAt),
  }),
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    type: notificationTypeEnum("type").notNull(),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => caseComments.id, {
      onDelete: "cascade",
    }),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    metadata: jsonb("metadata"),
    isRead: boolean("is_read").default(false).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    notificationsUserIdIdx: index("notifications_user_id_idx").on(table.userId),
    notificationsUserUnreadIdx: index("notifications_user_unread_idx").on(
      table.userId,
      table.isRead,
      table.createdAt,
    ),
    notificationsCreatedAtIdx: index("notifications_created_at_idx").on(table.createdAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type MerchantDocument = typeof merchantDocuments.$inferSelect;
export type NewMerchantDocument = typeof merchantDocuments.$inferInsert;
export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
export type Queue = typeof queues.$inferSelect;
export type NewQueue = typeof queues.$inferInsert;
export type QueueStage = typeof queueStages.$inferSelect;
export type NewQueueStage = typeof queueStages.$inferInsert;
export type CaseFieldReview = typeof caseFieldReviews.$inferSelect;
export type NewCaseFieldReview = typeof caseFieldReviews.$inferInsert;
export type CaseComment = typeof caseComments.$inferSelect;
export type NewCaseComment = typeof caseComments.$inferInsert;
export type CaseHistory = typeof caseHistory.$inferSelect;
export type NewCaseHistory = typeof caseHistory.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type CaseResubmissionToken = typeof caseResubmissionTokens.$inferSelect;
export type NewCaseResubmissionToken = typeof caseResubmissionTokens.$inferInsert;
export type EmailLog = typeof emailLog.$inferSelect;
export type NewEmailLog = typeof emailLog.$inferInsert;