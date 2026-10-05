import * as z from 'zod'

import {
  paymentMethodSettingsSchema,
  payoutMethodSettingsSchema,
} from '../configuration/configuration.schemas'

export const caseStatusValues = [
  'new',
  'working',
  'closed',
  'awaiting_merchant',
] as const
export type CaseStatusValue = (typeof caseStatusValues)[number]

export const caseListStatusFilterValues = [
  ...caseStatusValues,
  'unsuccessful',
] as const
export type CaseListStatusFilterValue =
  (typeof caseListStatusFilterValues)[number]

const caseListStatusFilterValueSet = new Set<string>(caseListStatusFilterValues)

// Status transitions that may be requested directly. Only Awaiting Merchant →
// Working (e.g. after a bounced merchant email). Closing goes through
// advance / close-unsuccessful so readiness checks and merchant updates run.
const allowedStatusTransitions: Record<
  CaseStatusValue,
  readonly CaseStatusValue[]
> = {
  new: [],
  working: [],
  awaiting_merchant: ['working'],
  closed: [],
}

/** Validates that a status transition is allowed. */
export function isValidStatusTransition(
  current: CaseStatusValue,
  next: CaseStatusValue,
): boolean {
  return allowedStatusTransitions[current].includes(next)
}

// ─── Request Schemas ────────────────────────────────────────────────────────

export const createCaseSchema = z.strictObject({
  merchantId: z.uuid(),
  queueId: z.uuid(),
  subMerchantId: z.uuid().optional(),
})

export type CreateCaseInput = z.infer<typeof createCaseSchema>

export const bulkCreateCaseSchema = z.strictObject({
  merchantIds: z.array(z.uuid()).min(1).max(200),
  queueId: z.uuid(),
  subMerchantId: z.uuid().optional(),
})

export type BulkCreateCaseInput = z.infer<typeof bulkCreateCaseSchema>

export const updateCaseStatusSchema = z.strictObject({
  status: z.enum(caseStatusValues),
})

export type UpdateCaseStatusInput = z.infer<typeof updateCaseStatusSchema>

export const confirmEmailDeliverySchema = z.strictObject({
  emailLogId: z.uuid(),
})

export const assignCaseSchema = z.strictObject({
  ownerId: z.uuid().nullable(),
})

export const bulkAssignCaseSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1),
  ownerId: z.uuid().nullable(),
})

export const updateCasePrioritySchema = z.strictObject({
  priority: z.enum(['normal', 'high']),
})

export const listCasesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
  queueAccess: z.enum(['view', 'work']).default('view'),
  search: z.string().optional(),
  queueId: z.uuid().optional(),
  ownerId: z.string().optional(),
  // Comma-separated, like ownerId and status.
  priority: z
    .string()
    .refine((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .every((item) => item === 'normal' || item === 'high'),
    )
    .optional(),
  merchantId: z
    .string()
    .refine((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .every((item) => z.uuid().safeParse(item).success),
    )
    .optional(),
  status: z
    .string()
    .refine((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .every((item) => caseListStatusFilterValueSet.has(item)),
    )
    .optional(),
  sortBy: z
    .enum([
      'caseNumber',
      'status',
      'createdAt',
      'closedAt',
      'updatedAt',
      'merchantName',
    ])
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  createdAtFrom: z.string().optional(),
  createdAtTo: z.string().optional(),
})

export type ListCasesQuery = z.infer<typeof listCasesQuerySchema>

// ─── Stage-based Schemas ────────────────────────────────────────────────────

export const stageCategoryValues = ['new', 'in_progress', 'closed'] as const
export type StageCategoryValue = (typeof stageCategoryValues)[number]

// ─── Field Review Schemas ───────────────────────────────────────────────────

export const fieldReviewStatusValues = [
  'pending',
  'approved',
  'rejected',
] as const
export const fieldReviewItemSchema = z.object({
  fieldName: z.string().min(1).max(120),
  status: z.enum(fieldReviewStatusValues),
  remarks: z.string().max(2000).optional(),
})

export const saveFieldReviewsSchema = z
  .strictObject({
    reviews: z.array(fieldReviewItemSchema).min(1).max(200),
  })
  .refine(
    (data) =>
      data.reviews.every(
        (r) =>
          r.status !== 'rejected' || (r.remarks && r.remarks.trim().length > 0),
      ),
    { error: 'Remarks are required for rejected fields.' },
  )

export type SaveFieldReviewsInput = z.infer<typeof saveFieldReviewsSchema>

export const saveDocumentReviewSubMerchantSchema = z.strictObject({
  subMerchantIds: z.array(z.uuid()).min(1).max(30),
})

export type SaveDocumentReviewSubMerchantInput = z.infer<
  typeof saveDocumentReviewSubMerchantSchema
>

// ─── Close Unsuccessful Schema ──────────────────────────────────────────────

export const closeUnsuccessfulSchema = z.strictObject({
  reason: z.string().min(1).max(2000),
})

export type CloseUnsuccessfulInput = z.infer<typeof closeUnsuccessfulSchema>

// ─── Comment Schemas ────────────────────────────────────────────────────────

export const createCommentSchema = z.strictObject({
  content: z.string().min(1).max(5000),
  parentId: z.uuid().optional(),
  mentions: z.array(z.uuid()).max(20).optional(),
})

export type CreateCommentInput = z.infer<typeof createCommentSchema>

// ─── Resubmission Schemas ───────────────────────────────────────────────────

export const emailRecipientTypeValues = ['submitter', 'business'] as const
export type EmailRecipientType = (typeof emailRecipientTypeValues)[number]

export const emailRecipientSelectionSchema = z.object({
  recipientEmailType: z.enum(emailRecipientTypeValues).default('submitter'),
})

// ─── Sub-Merchant Form Schemas ───────────────────────────────────────────────

export const selectSubMerchantFormSchema = z.strictObject({
  subMerchantKey: z.uuid({ error: 'Select a valid sub-merchant.' }),
})

export type SelectSubMerchantFormInput = z.infer<
  typeof selectSubMerchantFormSchema
>

export const sendAgreementEmailSchema = z.strictObject({
  remarks: z.string().max(2000).optional().nullable(),
  recipientEmailType:
    emailRecipientSelectionSchema.shape.recipientEmailType.optional(),
})

export type SendAgreementEmailInput = z.infer<typeof sendAgreementEmailSchema>

export const merchantPortalRoleValues = [
  'merchant_admin',
  'international_merchant_admin',
] as const

export type MerchantPortalRole = (typeof merchantPortalRoleValues)[number]

export function buildInternalMerchantEmail(email: string) {
  const normalizedEmail = email.trim()
  const atIndex = normalizedEmail.lastIndexOf('@')
  if (atIndex <= 0) return normalizedEmail
  return `${normalizedEmail.slice(0, atIndex)}internal${normalizedEmail.slice(atIndex)}`
}

export const saveMidCreationDetailsSchema = z
  .strictObject({
    portalMid: z.coerce.number().int().positive(),
    internalPortalMid: z.coerce.number().int().positive(),
    email: z.string().trim().max(255).pipe(z.email()),
    branchCode: z.string().trim().min(1).max(100),
    internalEmail: z.string().trim().max(255).pipe(z.email()),
    internalBranchCode: z.string().trim().min(1).max(100),
    merchantRole: z.enum(merchantPortalRoleValues),
    paymentMethods: paymentMethodSettingsSchema.min(
      1,
      'Select at least one payment method.',
    ),
    payoutMethods: payoutMethodSettingsSchema.min(1, 'Select a payout method.'),
  })
  .transform((input) => ({
    ...input,
    internalEmail: buildInternalMerchantEmail(input.email),
  }))

export type SaveMidCreationDetailsInput = z.infer<
  typeof saveMidCreationDetailsSchema
>

export const sendMidCreationEmailSchema = z.strictObject(
  emailRecipientSelectionSchema.shape,
)

export type SendMidCreationEmailInput = z.infer<
  typeof sendMidCreationEmailSchema
>

export const sendLiveEmailSchema = z.strictObject({
  recipientEmailType:
    emailRecipientSelectionSchema.shape.recipientEmailType.optional(),
})

export type SendLiveEmailInput = z.infer<typeof sendLiveEmailSchema>

export const markTestingLimitsAppliedSchema = z.strictObject({
  applied: z.literal(true),
})

// Printable ASCII without spaces, as issued by the merchant portal.
function portalApiCredentialValue(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(512, `${label} is too long.`)
    .regex(/^[!-~]+$/, `${label} must not contain spaces.`)
}

export const savePortalApiCredentialsSchema = z.strictObject({
  apiKey: portalApiCredentialValue('API Key'),
  apiSecret: portalApiCredentialValue('API Secret'),
})

export type SavePortalApiCredentialsInput = z.infer<
  typeof savePortalApiCredentialsSchema
>

export const markLiveLimitsAppliedSchema = z.strictObject({
  applied: z.literal(true),
})

export const saveWordpressWebsiteSchema = z.strictObject({
  clonedWebsiteLink: z.string().trim().max(2048).pipe(z.url()),
})

export type SaveWordpressWebsiteInput = z.infer<
  typeof saveWordpressWebsiteSchema
>
