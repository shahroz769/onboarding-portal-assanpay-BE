import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
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
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const roleTypeEnum = pgEnum('role_type', [
  'super_admin',
  'admin',
  'agent',
])

export const userStatusEnum = pgEnum('user_status', ['active', 'inactive'])
export const userGenderEnum = pgEnum('user_gender', ['male', 'female'])
export const queueViewScopeEnum = pgEnum('queue_view_scope', [
  'all',
  'selected',
])
export const userQueueAccessTypeEnum = pgEnum('user_queue_access_type', [
  'view',
  'work',
])
export const passwordTokenPurposeEnum = pgEnum('password_token_purpose', [
  'invite',
  'reset',
])

export const refreshTokenStatusEnum = pgEnum('refresh_token_status', [
  'active',
  'revoked',
  'rotated',
])

export const merchantTypeEnum = pgEnum('merchant_type', [
  'sole_proprietorship',
  'private_limited_company',
  'public_limited_company',
  'partnership',
  'limited_liability_partnership',
  'ngo_npo_charity',
  'trust_society_association',
])

export const merchantStatusEnum = pgEnum('merchant_status', [
  'pending',
  'testing',
  'live',
  'terminated',
])

export const kinRelationEnum = pgEnum('kin_relation', [
  'mother',
  'father',
  'brother',
  'sister',
  'spouse',
  'son',
  'daughter',
])

export const websiteCmsEnum = pgEnum('website_cms', [
  'wordpress',
  'shopify',
  'custom_website',
])

export const documentStatusEnum = pgEnum('document_status', [
  'pending',
  'approved',
  'rejected',
])

export const priorityEnum = pgEnum('priority', ['normal', 'high'])

export const businessScopeEnum = pgEnum('business_scope', [
  'local',
  'international',
])

export const merchantDocumentTypeEnum = pgEnum('merchant_document_type', [
  'owner_cnic_front',
  'owner_cnic_back',
  'next_of_kin_cnic_front',
  'next_of_kin_cnic_back',
  'utility_bill',
  'company_ntn',
  'authority_letter',
  'taxpayer_registration_certificate',
  'company_incorporation_certificate',
  'memorandum_articles',
  'form_ii',
  'form_a',
  'board_resolution',
  'certificate_of_commencement',
  'partnership_deed',
  'form_c',
  'llp_form_iii',
  'annual_audited_accounts',
  'other_entity_certification',
  'secp_section_42_license',
  'risk_assessment_documents',
  'by_laws_rules_regulations',
  'trust_deed',
  'trust_registration_certificate',
  'trustees_authorized_signatories_cnic',
  'proof_of_address',
  'tax_exemption_certificate',
  'other_supporting_documents',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    username: varchar('username', { length: 64 }).notNull().unique(),
    gender: userGenderEnum('gender').default('male').notNull(),
    passwordHash: text('password_hash'),
    roleType: roleTypeEnum('role_type').notNull(),
    status: userStatusEnum('status').default('active').notNull(),
    queueViewScope: queueViewScopeEnum('queue_view_scope')
      .default('all')
      .notNull(),
    sessionVersion: integer('session_version').default(0).notNull(),
    createdByUserId: uuid('created_by_user_id').references(
      (): AnyPgColumn => users.id,
      { onDelete: 'set null' },
    ),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    usersCreatedByIdx: index('users_created_by_idx').on(table.createdByUserId),
    usersSessionVersionNonnegative: check(
      'users_session_version_nonnegative',
      sql`${table.sessionVersion} >= 0`,
    ),
  }),
)

export const caseStatusEnum = pgEnum('case_status', [
  'new',
  'working',
  'pending',
  'qc',
  'error',
  'closed',
  'awaiting_client',
])

export const queueWorkflowTypeEnum = pgEnum('queue_workflow_type', [
  'generic',
  'document_review',
  'agreement',
  'mid',
  'testing',
  'wordpress',
  'card',
  'physical_agreement',
  'live',
  'sub_merchant_form',
])

export const queueLifecycleEnum = pgEnum('queue_lifecycle', [
  'draft',
  'active',
  'inactive',
])

export const queues = pgTable(
  'queues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull().unique(),
    slug: varchar('slug', { length: 120 }).notNull().unique(),
    prefix: varchar('prefix', { length: 4 }).notNull().unique(),
    workflowType: queueWorkflowTypeEnum('workflow_type')
      .default('generic')
      .notNull(),
    lifecycle: queueLifecycleEnum('lifecycle').default('inactive').notNull(),
    revision: integer('revision').default(1).notNull(),
    qcEnabled: boolean('qc_enabled').default(false).notNull(),
    slaHours: integer('sla_hours').default(24).notNull(),
    /** Kept in sync with lifecycle: active ↔ true, draft/inactive ↔ false. */
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check('queues_sla_hours_positive', sql`${table.slaHours} > 0`),
    check('queues_revision_positive', sql`${table.revision} >= 1`),
  ],
)

export const configurationSettings = pgTable('configuration_settings', {
  key: varchar('key', { length: 120 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const flowConfigurationRevisions = pgTable(
  'flow_configuration_revisions',
  {
    id: integer('id').primaryKey().default(1),
    revision: integer('revision').default(1).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check('flow_configuration_revisions_singleton', sql`${table.id} = 1`),
    check(
      'flow_configuration_revisions_revision_positive',
      sql`${table.revision} >= 1`,
    ),
  ],
)

export const agreementDraftTemplates = pgTable(
  'agreement_draft_templates',
  {
    businessType: varchar('business_type', { length: 120 }).primaryKey(),
    label: varchar('label', { length: 160 }).notNull(),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    googleDriveFileId: varchar('google_drive_file_id', {
      length: 255,
    }).notNull(),
    googleDriveWebViewLink: text('google_drive_web_view_link').notNull(),
    googleDriveDownloadLink: text('google_drive_download_link'),
    googleDriveFolderId: varchar('google_drive_folder_id', {
      length: 255,
    }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'agreement_draft_templates_size_nonnegative',
      sql`${table.sizeBytes} >= 0`,
    ),
  ],
)

export const subMerchantDraftTemplates = pgTable(
  'sub_merchant_draft_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 160 }).notNull().unique(),
    sellerCode: varchar('seller_code', { length: 80 }).notNull(),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    googleDriveFileId: varchar('google_drive_file_id', {
      length: 255,
    }).notNull(),
    googleDriveWebViewLink: text('google_drive_web_view_link').notNull(),
    googleDriveDownloadLink: text('google_drive_download_link'),
    googleDriveFolderId: varchar('google_drive_folder_id', {
      length: 255,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'sub_merchant_draft_templates_size_nonnegative',
      sql`${table.sizeBytes} >= 0`,
    ),
  ],
)

export const stageCategoryEnum = pgEnum('stage_category', [
  'new',
  'in_progress',
  'qc',
  'error',
  'closed',
])

export const queueStages = pgTable(
  'queue_stages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    order: integer('order').notNull(),
    category: stageCategoryEnum('category').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    capabilities: jsonb('capabilities').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    queueStagesIdQueueUniq: unique('queue_stages_id_queue_id_uniq').on(
      table.id,
      table.queueId,
    ),
    queueStagesQueueSlugUniq: uniqueIndex('queue_stages_queue_slug_uniq').on(
      table.queueId,
      table.slug,
    ),
    queueStagesQueueOrderUniq: uniqueIndex('queue_stages_queue_order_uniq').on(
      table.queueId,
      table.order,
    ),
    queueStagesOrderPositive: check(
      'queue_stages_order_positive',
      sql`${table.order} > 0`,
    ),
  }),
)

export const userQueueAccess = pgTable(
  'user_queue_access',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    accessType: userQueueAccessTypeEnum('access_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userQueueAccessPk: primaryKey({
      columns: [table.userId, table.queueId, table.accessType],
      name: 'user_queue_access_pk',
    }),
  }),
)

export const userPasswordTokens = pgTable(
  'user_password_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    purpose: passwordTokenPurposeEnum('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userPasswordTokensUserIdx: index('user_password_tokens_user_idx').on(
      table.userId,
    ),
    userPasswordTokensCreatedByIdx: index(
      'user_password_tokens_created_by_idx',
    ).on(table.createdBy),
  }),
)

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    status: refreshTokenStatusEnum('status').default('active').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByTokenId: uuid('replaced_by_token_id').references(
      (): AnyPgColumn => refreshTokens.id,
      { onDelete: 'set null' },
    ),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    refreshTokensUserIdIdx: index('refresh_tokens_user_id_idx').on(
      table.userId,
    ),
    refreshTokensExpiresAtIdx: index('refresh_tokens_expires_at_idx').on(
      table.expiresAt,
    ),
    refreshTokensReplacedByIdx: index('refresh_tokens_replaced_by_idx').on(
      table.replacedByTokenId,
    ),
  }),
)

export const merchants = pgTable(
  'merchants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    merchantNumber: serial('merchant_number').notNull().unique(),
    submitterEmail: varchar('submitter_email', { length: 255 }).notNull(),
    ownerFullName: varchar('owner_full_name', { length: 160 }).notNull(),
    ownerPhone: varchar('owner_phone', { length: 32 }).notNull(),
    activeWhatsappNumber: varchar('active_whatsapp_number', { length: 32 }),
    businessName: varchar('business_name', { length: 200 }).notNull(),
    businessPhone: varchar('business_phone', { length: 32 }).notNull(),
    businessEmail: varchar('business_email', { length: 255 }).notNull(),
    businessAddress: text('business_address').notNull(),
    businessWebsite: text('business_website').notNull(),
    websiteCms: websiteCmsEnum('website_cms').notNull(),
    businessDescription: text('business_description').notNull(),
    businessRegistrationDate: date('business_registration_date', {
      mode: 'string',
    }).notNull(),
    businessNature: varchar('business_nature', { length: 160 }).notNull(),
    merchantType: merchantTypeEnum('merchant_type').notNull(),
    estimatedMonthlyTransactions: integer(
      'estimated_monthly_transactions',
    ).notNull(),
    estimatedMonthlyVolume: numeric('estimated_monthly_volume', {
      precision: 14,
      scale: 2,
    }).notNull(),
    accountTitle: varchar('account_title', { length: 200 }).notNull(),
    bankName: varchar('bank_name', { length: 160 }).notNull(),
    branchName: varchar('branch_name', { length: 160 }).notNull(),
    accountNumberIban: varchar('account_number_iban', { length: 64 }).notNull(),
    swiftCode: varchar('swift_code', { length: 64 }),
    nextOfKinRelation: kinRelationEnum('next_of_kin_relation').notNull(),
    status: merchantStatusEnum('status').default('pending').notNull(),
    priority: priorityEnum('priority').default('normal').notNull(),
    priorityNote: varchar('priority_note', { length: 500 }),
    businessScope: businessScopeEnum('business_scope')
      .default('local')
      .notNull(),
    currency: varchar('currency', { length: 8 }).default('PKR').notNull(),
    limitsMdrOverride: jsonb('limits_mdr_override'),
    googleDrivePrivateFolderId: varchar('google_drive_private_folder_id', {
      length: 255,
    }),
    googleDrivePublicFolderId: varchar('google_drive_public_folder_id', {
      length: 255,
    }),
    liveAt: timestamp('live_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    merchantsSubmitterEmailIdx: index('merchants_submitter_email_idx').on(
      table.submitterEmail,
    ),
    merchantsBusinessEmailIdx: index('merchants_business_email_idx').on(
      table.businessEmail,
    ),
    merchantsOwnerPhoneIdx: index('merchants_owner_phone_idx').on(
      table.ownerPhone,
    ),
    merchantsBusinessPhoneIdx: index('merchants_business_phone_idx').on(
      table.businessPhone,
    ),
    merchantsActiveWhatsappNumberIdx: index(
      'merchants_active_whatsapp_number_idx',
    ).on(table.activeWhatsappNumber),
    merchantsBusinessNameIdx: index('merchants_business_name_idx').on(
      table.businessName,
    ),
    merchantsStatusIdx: index('merchants_status_idx').on(table.status),
    merchantsPriorityIdx: index('merchants_priority_idx').on(table.priority),
    merchantsActiveNumberIdx: index('merchants_active_number_idx')
      .on(table.merchantNumber, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    merchantsActiveCreatedIdx: index('merchants_active_created_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    merchantsActiveBusinessNameLowerIdx: index(
      'merchants_active_business_name_lower_idx',
    )
      .on(sql`lower(${table.businessName})`, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    merchantsActivePriorityCreatedIdx: index(
      'merchants_active_priority_created_idx',
    )
      .on(table.priority, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    merchantsActiveStatusIdIdx: index('merchants_active_status_id_idx')
      .on(table.status, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    merchantsActiveScopeIdIdx: index('merchants_active_scope_id_idx')
      .on(table.businessScope, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    merchantsBusinessNameTrgmIdx: index(
      'merchants_business_name_trgm_idx',
    ).using('gin', sql`${table.businessName} gin_trgm_ops`),
    merchantsSubmitterEmailTrgmIdx: index(
      'merchants_submitter_email_trgm_idx',
    ).using('gin', sql`${table.submitterEmail} gin_trgm_ops`),
    merchantsTransactionsNonnegative: check(
      'merchants_transactions_nonnegative',
      sql`${table.estimatedMonthlyTransactions} >= 0`,
    ),
    merchantsVolumeNonnegative: check(
      'merchants_volume_nonnegative',
      sql`${table.estimatedMonthlyVolume} >= 0`,
    ),
  }),
)

export const merchantDocuments = pgTable(
  'merchant_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    documentType: merchantDocumentTypeEnum('document_type').notNull(),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    googleDriveFileId: varchar('google_drive_file_id', {
      length: 255,
    }).notNull(),
    googleDriveWebViewLink: text('google_drive_web_view_link').notNull(),
    googleDriveDownloadLink: text('google_drive_download_link'),
    googleDriveFolderId: varchar('google_drive_folder_id', {
      length: 255,
    }).notNull(),
    status: documentStatusEnum('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    merchantDocumentsMerchantIdIdx: index(
      'merchant_documents_merchant_id_idx',
    ).on(table.merchantId),
    merchantDocumentsTypeIdx: index('merchant_documents_type_idx').on(
      table.documentType,
    ),
    merchantDocumentsSizeNonnegative: check(
      'merchant_documents_size_nonnegative',
      sql`${table.sizeBytes} >= 0`,
    ),
  }),
)

export const queueCaseSequences = pgTable(
  'queue_case_sequences',
  {
    queueId: uuid('queue_id')
      .primaryKey()
      .references(() => queues.id, { onDelete: 'cascade' }),
    lastNumber: integer('last_number').default(0).notNull(),
  },
  (table) => [
    check(
      'queue_case_sequences_last_number_nonnegative',
      sql`${table.lastNumber} >= 0`,
    ),
  ],
)

export const caseCloseOutcomeEnum = pgEnum('case_close_outcome', [
  'successful',
  'unsuccessful',
])

export const cases = pgTable(
  'cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseNumber: varchar('case_number', { length: 20 }).notNull().unique(),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    subMerchantId: uuid('sub_merchant_id').references(
      () => subMerchantDraftTemplates.id,
      { onDelete: 'restrict' },
    ),
    ownerId: uuid('owner_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    currentStageId: uuid('current_stage_id'),
    status: caseStatusEnum('status').default('new').notNull(),
    priority: priorityEnum('priority').default('normal').notNull(),
    closeOutcome: caseCloseOutcomeEnum('close_outcome'),
    slaBreached: boolean('sla_breached'),
    closeReason: text('close_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    casesMerchantQueueIdx: index('cases_merchant_queue_idx').on(
      table.merchantId,
      table.queueId,
    ),
    casesMerchantCreatedIdx: index('cases_merchant_created_idx').on(
      table.merchantId,
      table.createdAt,
      table.id,
    ),
    casesSubMerchantIdIdx: index('cases_sub_merchant_id_idx').on(
      table.subMerchantId,
    ),
    casesCurrentStageQueueIdx: index('cases_current_stage_queue_idx').on(
      table.currentStageId,
      table.queueId,
    ),
    casesListCreatedIdx: index('cases_list_created_idx').on(
      table.createdAt,
      table.id,
    ),
    casesCaseNumberIdIdx: index('cases_case_number_id_idx').on(
      table.caseNumber,
      table.id,
    ),
    casesStatusIdIdx: index('cases_status_id_idx').on(table.status, table.id),
    casesClosedIdIdx: index('cases_closed_id_idx').on(table.closedAt, table.id),
    casesClosedCoalesceIdIdx: index('cases_closed_coalesce_id_idx').on(
      sql`coalesce(${table.closedAt}, '0001-01-01 00:00:00+00'::timestamptz)`,
      table.id,
    ),
    casesUpdatedIdIdx: index('cases_updated_id_idx').on(
      table.updatedAt,
      table.id,
    ),
    casesQueueCreatedIdx: index('cases_queue_created_idx').on(
      table.queueId,
      table.createdAt,
      table.id,
    ),
    casesOwnerCreatedIdx: index('cases_owner_created_idx').on(
      table.ownerId,
      table.createdAt,
      table.id,
    ),
    casesStatusCreatedIdx: index('cases_status_created_idx').on(
      table.status,
      table.createdAt,
      table.id,
    ),
    casesCaseNumberTrgmIdx: index('cases_case_number_trgm_idx').using(
      'gin',
      sql`${table.caseNumber} gin_trgm_ops`,
    ),
    casesOpenMerchantIdx: index('cases_open_merchant_idx')
      .on(table.merchantId, table.queueId)
      .where(sql`${table.status} NOT IN ('closed', 'error')`),
    casesSuccessfulFlowIdx: index('cases_successful_flow_idx')
      .on(table.merchantId, table.queueId)
      .where(
        sql`${table.status} = 'closed' AND ${table.closeOutcome} = 'successful'`,
      ),
    casesCurrentStageQueueFk: foreignKey({
      columns: [table.currentStageId, table.queueId],
      foreignColumns: [queueStages.id, queueStages.queueId],
      name: 'cases_current_stage_id_queue_id_fk',
    }).onDelete('set null'),
  }),
)

export const fieldReviewStatusEnum = pgEnum('field_review_status', [
  'pending',
  'approved',
  'rejected',
])

export const caseFieldReviews = pgTable(
  'case_field_reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    fieldName: varchar('field_name', { length: 120 }).notNull(),
    status: fieldReviewStatusEnum('status').default('pending').notNull(),
    remarks: text('remarks'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    resubmittedAt: timestamp('resubmitted_at', { withTimezone: true }),
  },
  (table) => ({
    caseFieldReviewsReviewedByIdx: index(
      'case_field_reviews_reviewed_by_idx',
    ).on(table.reviewedBy),
    caseFieldReviewsCaseFieldUniq: uniqueIndex(
      'case_field_reviews_case_field_uniq',
    ).on(table.caseId, table.fieldName),
  }),
)

export const documentReviewDetails = pgTable(
  'document_review_details',
  {
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    subMerchantId: uuid('sub_merchant_id')
      .notNull()
      .references(() => subMerchantDraftTemplates.id, { onDelete: 'restrict' }),
    subMerchantName: varchar('sub_merchant_name', { length: 160 }).notNull(),
    selectedBy: uuid('selected_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    documentReviewDetailsPk: primaryKey({
      columns: [table.caseId, table.subMerchantId],
      name: 'document_review_details_pkey',
    }),
    documentReviewDetailsSubMerchantIdx: index(
      'document_review_details_sub_merchant_idx',
    ).on(table.subMerchantId),
    documentReviewDetailsSelectedByIdx: index(
      'document_review_details_selected_by_idx',
    ).on(table.selectedBy),
  }),
)

export const caseComments = pgTable(
  'case_comments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    content: text('content').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => caseComments.id, {
      onDelete: 'set null',
    }),
    mentions: text('mentions').array(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseCommentsCaseCreatedIdx: index('case_comments_case_created_idx').on(
      table.caseId,
      table.createdAt,
      table.id,
    ),
    caseCommentsAuthorIdIdx: index('case_comments_author_id_idx').on(
      table.authorId,
    ),
    caseCommentsParentIdIdx: index('case_comments_parent_id_idx').on(
      table.parentId,
    ),
  }),
)

export const caseHistory = pgTable(
  'case_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    action: varchar('action', { length: 64 }).notNull(),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseHistoryCaseActionCreatedIdx: index(
      'case_history_case_action_created_idx',
    ).on(table.caseId, table.action, table.createdAt),
    caseHistoryCaseCreatedIdx: index('case_history_case_created_idx').on(
      table.caseId,
      table.createdAt,
      table.id,
    ),
    caseHistoryActorIdx: index('case_history_actor_idx').on(table.actorId),
  }),
)

export const caseFlowStartRules = pgTable(
  'case_flow_start_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    targetQueueId: uuid('target_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    order: integer('order').default(1).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseFlowStartRulesTargetQueueUnique: uniqueIndex(
      'case_flow_start_rules_target_queue_unique',
    )
      .on(table.targetQueueId)
      .where(sql`${table.isActive} = true`),
    caseFlowStartRulesOrderIdx: index('case_flow_start_rules_order_idx').on(
      table.order,
    ),
    caseFlowStartRulesOrderPositive: check(
      'case_flow_start_rules_order_positive',
      sql`${table.order} > 0`,
    ),
  }),
)

export const caseFlowCloseTriggers = pgTable(
  'case_flow_close_triggers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceQueueId: uuid('source_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    targetQueueId: uuid('target_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    order: integer('order').default(1).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseFlowCloseTriggersSourceTargetUnique: uniqueIndex(
      'case_flow_close_triggers_source_target_unique',
    )
      .on(table.sourceQueueId, table.targetQueueId)
      .where(sql`${table.isActive} = true`),
    caseFlowCloseTriggersSourceOrderIdx: index(
      'case_flow_close_triggers_source_order_idx',
    ).on(table.sourceQueueId, table.order),
    caseFlowCloseTriggersOrderPositive: check(
      'case_flow_close_triggers_order_positive',
      sql`${table.order} > 0`,
    ),
  }),
)

export const caseFlowCloseBlockers = pgTable(
  'case_flow_close_blockers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    blockedQueueId: uuid('blocked_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    prerequisiteQueueId: uuid('prerequisite_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseFlowCloseBlockersBlockedPrerequisiteUnique: uniqueIndex(
      'case_flow_close_blockers_blocked_prerequisite_unique',
    )
      .on(table.blockedQueueId, table.prerequisiteQueueId)
      .where(sql`${table.isActive} = true`),
  }),
)

export const caseFlowCreationRequirements = pgTable(
  'case_flow_creation_requirements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    targetQueueId: uuid('target_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    prerequisiteQueueId: uuid('prerequisite_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseFlowCreationRequirementsTargetPrerequisiteUnique: uniqueIndex(
      'case_flow_creation_requirements_target_prerequisite_unique',
    )
      .on(table.targetQueueId, table.prerequisiteQueueId)
      .where(sql`${table.isActive} = true`),
  }),
)

export const caseLinks = pgTable(
  'case_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    parentCaseId: uuid('parent_case_id').references(() => cases.id, {
      onDelete: 'set null',
    }),
    childCaseId: uuid('child_case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    triggerType: varchar('trigger_type', { length: 40 }).notNull(),
    sourceQueueId: uuid('source_queue_id').references(() => queues.id, {
      onDelete: 'set null',
    }),
    targetQueueId: uuid('target_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseLinksParentIdx: index('case_links_parent_idx').on(table.parentCaseId),
    caseLinksChildIdx: uniqueIndex('case_links_child_unique').on(
      table.childCaseId,
    ),
    caseLinksMerchantIdx: index('case_links_merchant_idx').on(table.merchantId),
  }),
)

export const caseFlowCloseJobs = pgTable(
  'case_flow_close_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceCaseId: uuid('source_case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    sourceQueueId: uuid('source_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'restrict' }),
    targetQueueId: uuid('target_queue_id')
      .notNull()
      .references(() => queues.id, { onDelete: 'restrict' }),
    attempts: integer('attempts').default(0).notNull(),
    onlyIfTargetMissing: boolean('only_if_target_missing')
      .default(true)
      .notNull(),
    availableAt: timestamp('available_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseFlowCloseJobsSourceTargetUnique: uniqueIndex(
      'case_flow_close_jobs_source_target_unique',
    ).on(table.sourceCaseId, table.targetQueueId),
    caseFlowCloseJobsPendingIdx: index('case_flow_close_jobs_pending_idx')
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.completedAt} IS NULL`),
    caseFlowCloseJobsProblemIdx: index('case_flow_close_jobs_problem_idx')
      .on(table.lastAttemptAt, table.createdAt)
      .where(
        sql`${table.completedAt} IS NULL AND ${table.lastError} IS NOT NULL`,
      ),
    caseFlowCloseJobsMerchantIdx: index('case_flow_close_jobs_merchant_idx').on(
      table.merchantId,
    ),
    caseFlowCloseJobsSourceQueueIdx: index(
      'case_flow_close_jobs_source_queue_idx',
    ).on(table.sourceQueueId),
    caseFlowCloseJobsTargetQueueIdx: index(
      'case_flow_close_jobs_target_queue_idx',
    ).on(table.targetQueueId),
    caseFlowCloseJobsAttemptsNonnegative: check(
      'case_flow_close_jobs_attempts_nonnegative',
      sql`${table.attempts} >= 0`,
    ),
  }),
)

export const notificationTypeEnum = pgEnum('notification_type', [
  'case_assigned',
  'case_unassigned',
  'comment_mention',
  'comment_reply',
  'comment_thread',
  'case_resubmitted',
])

export const emailLogStatusEnum = pgEnum('email_log_status', [
  'queued',
  'sent',
  'failed',
])

export const caseResubmissionTokens = pgTable(
  'case_resubmission_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 86 }).unique(),
    tokenHash: varchar('token_hash', { length: 64 }).unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseResubmissionTokensCaseIdIdx: index(
      'case_resubmission_tokens_case_id_idx',
    ).on(table.caseId),
    caseResubmissionTokensCreatedByIdx: index(
      'case_resubmission_tokens_created_by_idx',
    ).on(table.createdBy),
    caseResubmissionTokensOneActivePerCaseIdx: uniqueIndex(
      'case_resubmission_tokens_one_active_per_case_idx',
    )
      .on(table.caseId)
      .where(sql`${table.consumedAt} is null`),
  }),
)

export const emailLog = pgTable(
  'email_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    toEmail: varchar('to_email', { length: 255 }).notNull(),
    subject: varchar('subject', { length: 500 }).notNull(),
    template: varchar('template', { length: 120 }).notNull(),
    caseId: uuid('case_id').references(() => cases.id, {
      onDelete: 'set null',
    }),
    merchantId: uuid('merchant_id').references(() => merchants.id, {
      onDelete: 'set null',
    }),
    resendId: varchar('resend_id', { length: 255 }),
    status: emailLogStatusEnum('status').default('queued').notNull(),
    errorMsg: text('error_msg'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    emailLogCaseIdIdx: index('email_log_case_id_idx').on(table.caseId),
    emailLogMerchantIdIdx: index('email_log_merchant_id_idx').on(
      table.merchantId,
    ),
    emailLogStatusIdx: index('email_log_status_idx').on(table.status),
    emailLogCreatedAtIdx: index('email_log_created_at_idx').on(table.createdAt),
  }),
)

export const midGoLiveTokens = pgTable(
  'mid_go_live_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 86 }).unique(),
    tokenHash: varchar('token_hash', { length: 64 }).unique(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    liveCaseId: uuid('live_case_id').references(() => cases.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    midGoLiveTokensCaseIdIdx: index('mid_go_live_tokens_case_id_idx').on(
      table.caseId,
    ),
    midGoLiveTokensAvailableAtIdx: index(
      'mid_go_live_tokens_available_at_idx',
    ).on(table.availableAt),
    midGoLiveTokensLiveCaseIdx: index('mid_go_live_tokens_live_case_idx').on(
      table.liveCaseId,
    ),
    midGoLiveTokensCreatedByIdx: index('mid_go_live_tokens_created_by_idx').on(
      table.createdBy,
    ),
  }),
)

export const portalMidLimitApplications = pgTable(
  'portal_mid_limit_applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    portalMid: integer('portal_mid').notNull(),
    category: varchar('category', { length: 32 }),
    merchantId: uuid('merchant_id').references(() => merchants.id, {
      onDelete: 'cascade',
    }),
    appliedBy: uuid('applied_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    appliedAt: timestamp('applied_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    portalMidLimitApplicationsMidIdx: uniqueIndex(
      'portal_mid_limit_applications_mid_idx',
    ).on(table.portalMid),
    portalMidLimitApplicationsMerchantIdx: index(
      'portal_mid_limit_applications_merchant_idx',
    ).on(table.merchantId),
    portalMidLimitApplicationsAppliedByIdx: index(
      'portal_mid_limit_applications_applied_by_idx',
    ).on(table.appliedBy),
    portalMidLimitApplicationsMidPositive: check(
      'portal_mid_limit_applications_mid_positive',
      sql`${table.portalMid} > 0`,
    ),
    portalMidLimitApplicationsCategoryValid: check(
      'portal_mid_limit_applications_category_valid',
      sql`${table.category} is null or ${table.category} in ('custom_wordpress', 'shopify', 'internal')`,
    ),
  }),
)

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    type: notificationTypeEnum('type').notNull(),
    caseId: uuid('case_id').references(() => cases.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id').references(() => caseComments.id, {
      onDelete: 'cascade',
    }),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body').notNull(),
    metadata: jsonb('metadata'),
    isRead: boolean('is_read').default(false).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    notificationsCreatedAtIdx: index('notifications_created_at_idx').on(
      table.createdAt,
    ),
    notificationsUserCreatedIdIdx: index(
      'notifications_user_created_id_idx',
    ).on(table.userId, table.createdAt, table.id),
    notificationsUserUnreadCreatedIdIdx: index(
      'notifications_user_unread_created_id_idx',
    ).on(table.userId, table.isRead, table.createdAt, table.id),
    notificationsActorIdx: index('notifications_actor_idx').on(table.actorId),
    notificationsCaseIdx: index('notifications_case_idx').on(table.caseId),
    notificationsCommentIdx: index('notifications_comment_idx').on(
      table.commentId,
    ),
  }),
)

export const caseFiles = pgTable(
  'case_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    fileKind: varchar('file_kind', { length: 80 }).notNull(),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    googleDriveFileId: varchar('google_drive_file_id', {
      length: 255,
    }).notNull(),
    googleDriveWebViewLink: text('google_drive_web_view_link').notNull(),
    googleDriveDownloadLink: text('google_drive_download_link'),
    googleDriveFolderId: varchar('google_drive_folder_id', {
      length: 255,
    }).notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    caseFilesUploaderIdx: index('case_files_uploaded_by_idx').on(
      table.uploadedBy,
    ),
    caseFilesCaseKindUniq: uniqueIndex('case_files_case_kind_uniq').on(
      table.caseId,
      table.fileKind,
    ),
    caseFilesSizeNonnegative: check(
      'case_files_size_nonnegative',
      sql`${table.sizeBytes} >= 0`,
    ),
  }),
)

export const subMerchantFormEmailStatusEnum = pgEnum(
  'sub_merchant_form_email_status',
  ['not_sent', 'sent', 'failed'],
)

export const subMerchantFormDetails = pgTable(
  'sub_merchant_form_details',
  {
    caseId: uuid('case_id')
      .primaryKey()
      .references(() => cases.id, { onDelete: 'cascade' }),
    subMerchantKey: varchar('sub_merchant_key', { length: 80 }).notNull(),
    subMerchantName: varchar('sub_merchant_name', { length: 160 }).notNull(),
    draftUrl: text('draft_url').notNull(),
    finalFormFileId: uuid('final_form_file_id').references(() => caseFiles.id, {
      onDelete: 'set null',
    }),
    emailStatus: subMerchantFormEmailStatusEnum('email_status')
      .default('not_sent')
      .notNull(),
    emailLogId: uuid('email_log_id').references(() => emailLog.id, {
      onDelete: 'set null',
    }),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    emailRecipient: varchar('email_recipient', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    subMerchantFormDetailsFinalFormIdx: index(
      'sub_merchant_form_details_final_form_idx',
    ).on(table.finalFormFileId),
    subMerchantFormDetailsEmailLogIdx: index(
      'sub_merchant_form_details_email_log_idx',
    ).on(table.emailLogId),
  }),
)

export const agreementEmailStatusEnum = pgEnum('agreement_email_status', [
  'not_sent',
  'sent',
  'failed',
])

export const storageObjectKindEnum = pgEnum('storage_object_kind', [
  'file',
  'folder',
])

export const storageObjectVisibilityEnum = pgEnum('storage_object_visibility', [
  'private',
  'public',
])

export const storageObjectLifecycleEnum = pgEnum('storage_object_lifecycle', [
  'provisioning',
  'current',
  'superseded',
  'failed',
])

export const storageObjects = pgTable(
  'storage_objects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: varchar('provider', { length: 40 })
      .default('google_drive')
      .notNull(),
    providerObjectId: varchar('provider_object_id', { length: 255 }).notNull(),
    objectKind: storageObjectKindEnum('object_kind').notNull(),
    merchantId: uuid('merchant_id').references(() => merchants.id, {
      onDelete: 'cascade',
    }),
    caseId: uuid('case_id').references(() => cases.id, {
      onDelete: 'set null',
    }),
    visibility: storageObjectVisibilityEnum('visibility').notNull(),
    attemptId: uuid('attempt_id').notNull(),
    lifecycle: storageObjectLifecycleEnum('lifecycle')
      .default('provisioning')
      .notNull(),
    parentProviderObjectId: varchar('parent_provider_object_id', {
      length: 255,
    }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    storageObjectsProviderObjectUniq: uniqueIndex(
      'storage_objects_provider_object_uniq',
    ).on(table.provider, table.providerObjectId),
    storageObjectsAttemptIdx: index('storage_objects_attempt_idx').on(
      table.attemptId,
    ),
    storageObjectsMerchantAttemptIdx: index(
      'storage_objects_merchant_attempt_idx',
    ).on(table.merchantId, table.attemptId),
    storageObjectsCaseAttemptIdx: index('storage_objects_case_attempt_idx').on(
      table.caseId,
      table.attemptId,
    ),
    storageObjectsMerchantRootClaimUniq: uniqueIndex(
      'storage_objects_merchant_root_claim_uniq',
    )
      .on(table.merchantId, table.visibility)
      .where(
        sql`(${table.metadata}->>'role') = 'merchant_root' AND ${table.lifecycle} IN ('provisioning', 'current')`,
      ),
  }),
)

export const agreementCaseDetails = pgTable(
  'agreement_case_details',
  {
    caseId: uuid('case_id')
      .primaryKey()
      .references(() => cases.id, { onDelete: 'cascade' }),
    businessType: varchar('business_type', { length: 120 }).notNull(),
    draftKey: varchar('draft_key', { length: 80 }).notNull(),
    draftLabel: varchar('draft_label', { length: 120 }).notNull(),
    draftUrl: text('draft_url').notNull(),
    finalAgreementFileId: uuid('final_agreement_file_id').references(
      () => caseFiles.id,
      {
        onDelete: 'set null',
      },
    ),
    receivedAgreementFileId: uuid('received_agreement_file_id').references(
      () => caseFiles.id,
      {
        onDelete: 'set null',
      },
    ),
    emailStatus: agreementEmailStatusEnum('email_status')
      .default('not_sent')
      .notNull(),
    emailLogId: uuid('email_log_id').references(() => emailLog.id, {
      onDelete: 'set null',
    }),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    emailRecipient: varchar('email_recipient', { length: 255 }),
    lastRejectionRemarks: text('last_rejection_remarks'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    agreementCaseDetailsFinalFileIdx: index(
      'agreement_case_details_final_file_idx',
    ).on(table.finalAgreementFileId),
    agreementCaseDetailsReceivedFileIdx: index(
      'agreement_case_details_received_file_idx',
    ).on(table.receivedAgreementFileId),
    agreementCaseDetailsEmailLogIdx: index(
      'agreement_case_details_email_log_idx',
    ).on(table.emailLogId),
  }),
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type UserQueueAccess = typeof userQueueAccess.$inferSelect
export type UserPasswordToken = typeof userPasswordTokens.$inferSelect
export type Merchant = typeof merchants.$inferSelect
export type NewMerchant = typeof merchants.$inferInsert
export type MerchantDocument = typeof merchantDocuments.$inferSelect
export type NewMerchantDocument = typeof merchantDocuments.$inferInsert
export type Case = typeof cases.$inferSelect
export type NewCase = typeof cases.$inferInsert
export type Queue = typeof queues.$inferSelect
export type NewQueue = typeof queues.$inferInsert
export type ConfigurationSetting = typeof configurationSettings.$inferSelect
export type NewConfigurationSetting = typeof configurationSettings.$inferInsert
export type FlowConfigurationRevision =
  typeof flowConfigurationRevisions.$inferSelect
export type NewFlowConfigurationRevision =
  typeof flowConfigurationRevisions.$inferInsert
export type AgreementDraftTemplate = typeof agreementDraftTemplates.$inferSelect
export type NewAgreementDraftTemplate =
  typeof agreementDraftTemplates.$inferInsert
export type SubMerchantDraftTemplate =
  typeof subMerchantDraftTemplates.$inferSelect
export type NewSubMerchantDraftTemplate =
  typeof subMerchantDraftTemplates.$inferInsert
export type QueueStage = typeof queueStages.$inferSelect
export type NewQueueStage = typeof queueStages.$inferInsert
export type MidGoLiveToken = typeof midGoLiveTokens.$inferSelect
export type NewMidGoLiveToken = typeof midGoLiveTokens.$inferInsert
export type PortalMidLimitApplication =
  typeof portalMidLimitApplications.$inferSelect
export type NewPortalMidLimitApplication =
  typeof portalMidLimitApplications.$inferInsert
export type CaseFieldReview = typeof caseFieldReviews.$inferSelect
export type NewCaseFieldReview = typeof caseFieldReviews.$inferInsert
export type DocumentReviewDetails = typeof documentReviewDetails.$inferSelect
export type NewDocumentReviewDetails = typeof documentReviewDetails.$inferInsert
export type CaseComment = typeof caseComments.$inferSelect
export type NewCaseComment = typeof caseComments.$inferInsert
export type CaseHistory = typeof caseHistory.$inferSelect
export type NewCaseHistory = typeof caseHistory.$inferInsert
export type CaseFlowStartRule = typeof caseFlowStartRules.$inferSelect
export type NewCaseFlowStartRule = typeof caseFlowStartRules.$inferInsert
export type CaseFlowCloseTrigger = typeof caseFlowCloseTriggers.$inferSelect
export type NewCaseFlowCloseTrigger = typeof caseFlowCloseTriggers.$inferInsert
export type CaseFlowCloseBlocker = typeof caseFlowCloseBlockers.$inferSelect
export type NewCaseFlowCloseBlocker = typeof caseFlowCloseBlockers.$inferInsert
export type CaseFlowCreationRequirement =
  typeof caseFlowCreationRequirements.$inferSelect
export type NewCaseFlowCreationRequirement =
  typeof caseFlowCreationRequirements.$inferInsert
export type CaseLink = typeof caseLinks.$inferSelect
export type NewCaseLink = typeof caseLinks.$inferInsert
export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
export type CaseResubmissionToken = typeof caseResubmissionTokens.$inferSelect
export type NewCaseResubmissionToken =
  typeof caseResubmissionTokens.$inferInsert
export type EmailLog = typeof emailLog.$inferSelect
export type NewEmailLog = typeof emailLog.$inferInsert
export type CaseFile = typeof caseFiles.$inferSelect
export type NewCaseFile = typeof caseFiles.$inferInsert
export type SubMerchantFormDetails = typeof subMerchantFormDetails.$inferSelect
export type NewSubMerchantFormDetails =
  typeof subMerchantFormDetails.$inferInsert
export type AgreementCaseDetails = typeof agreementCaseDetails.$inferSelect
export type NewAgreementCaseDetails = typeof agreementCaseDetails.$inferInsert
export type StorageObject = typeof storageObjects.$inferSelect
export type NewStorageObject = typeof storageObjects.$inferInsert
