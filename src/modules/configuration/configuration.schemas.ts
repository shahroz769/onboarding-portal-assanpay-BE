import { z } from 'zod'

const nullableHoursField = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : v),
  z.number().int().min(1).max(8760).nullable(),
)

export const linkDeadlineSettingsSchema = z
  .object({
    passwordResetHours: nullableHoursField,
    newPasswordSetHours: nullableHoursField,
    agreementLinkHours: nullableHoursField,
    documentsReviewResubmissionHours: nullableHoursField,
    goLiveAvailabilityHours: nullableHoursField,
  })
  .strict()

export const emailSendingModeSettingsSchema = z
  .object({
    autoEnabled: z.boolean(),
    manualEnabled: z.boolean(),
  })
  .strict()
  .refine((value) => value.autoEnabled || value.manualEnabled, {
    message: 'At least one email sending mode must be enabled.',
    path: ['autoEnabled'],
  })

export const merchantPortalSettingsSchema = z
  .object({
    loginUrl: z.string().trim().url().max(2048),
  })
  .strict()

export const limitsAndMdrSettingsSchema = z
  .object({
    testing: z.object({
      collectionMin: z.coerce.number().min(0),
      collectionMax: z.coerce.number().min(0),
      disbursementMin: z.coerce.number().min(0),
      disbursementMax: z.coerce.number().min(0),
    }),
    live: z.object({
      collectionMin: z.coerce.number().min(0),
      collectionMax: z.coerce.number().min(0),
      disbursementMin: z.coerce.number().min(0),
      disbursementMax: z.coerce.number().min(0),
    }),
    rates: z.object({
      eWallets: z.coerce.number().min(0).max(100),
      cardDefault: z.coerce.number().min(0).max(100),
      cardShopify: z.coerce.number().min(0).max(100),
      payout: z.coerce.number().min(0).max(100),
    }),
  })
  .strict()
  .refine(
    (value) => value.testing.collectionMax >= value.testing.collectionMin,
    {
      message: 'Testing collection max must be greater than or equal to min.',
      path: ['testing', 'collectionMax'],
    },
  )
  .refine(
    (value) => value.testing.disbursementMax >= value.testing.disbursementMin,
    {
      message: 'Testing disbursement max must be greater than or equal to min.',
      path: ['testing', 'disbursementMax'],
    },
  )
  .refine((value) => value.live.collectionMax >= value.live.collectionMin, {
    message: 'Live collection max must be greater than or equal to min.',
    path: ['live', 'collectionMax'],
  })
  .refine((value) => value.live.disbursementMax >= value.live.disbursementMin, {
    message: 'Live disbursement max must be greater than or equal to min.',
    path: ['live', 'disbursementMax'],
  })

export const BUSINESS_TYPE_OPTIONS = [
  { value: 'sole_proprietorship', label: 'Sole Proprietorship' },
  { value: 'private_limited_company', label: 'Private Limited Company' },
  { value: 'public_limited_company', label: 'Public Limited Company' },
  { value: 'partnership', label: 'Partnership' },
  {
    value: 'limited_liability_partnership',
    label: 'Limited Liability Partnership',
  },
  { value: 'ngo_npo_charity', label: 'NGO / NPO / Charity' },
  {
    value: 'trust_society_association',
    label: 'Trust / Society / Association',
  },
] as const

export const businessTypeSchema = z.enum([
  'sole_proprietorship',
  'private_limited_company',
  'public_limited_company',
  'partnership',
  'limited_liability_partnership',
  'ngo_npo_charity',
  'trust_society_association',
])

const caseFlowStartRuleInputSchema = z
  .object({
    targetQueueId: z.string().uuid(),
    order: z.coerce.number().int().min(1).default(1),
    isActive: z.boolean().default(true),
  })
  .strict()

const caseFlowCloseTriggerInputSchema = z
  .object({
    sourceQueueId: z.string().uuid(),
    targetQueueId: z.string().uuid(),
    order: z.coerce.number().int().min(1).default(1),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.sourceQueueId !== value.targetQueueId, {
    message: 'A queue cannot trigger itself.',
    path: ['targetQueueId'],
  })

const caseFlowCloseBlockerInputSchema = z
  .object({
    blockedQueueId: z.string().uuid(),
    prerequisiteQueueId: z.string().uuid(),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.blockedQueueId !== value.prerequisiteQueueId, {
    message: 'A queue cannot require itself before closing.',
    path: ['prerequisiteQueueId'],
  })

const caseFlowCreationRequirementInputSchema = z
  .object({
    targetQueueId: z.string().uuid(),
    prerequisiteQueueId: z.string().uuid(),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.targetQueueId !== value.prerequisiteQueueId, {
    message: 'A queue cannot require itself before creation.',
    path: ['prerequisiteQueueId'],
  })

export const updateCaseFlowConfigurationSchema = z
  .object({
    startRules: z.array(caseFlowStartRuleInputSchema),
    closeTriggers: z.array(caseFlowCloseTriggerInputSchema),
    closeBlockers: z.array(caseFlowCloseBlockerInputSchema),
    creationRequirements: z
      .array(caseFlowCreationRequirementInputSchema)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIssue(
      value.startRules.map((rule) => rule.targetQueueId),
      ctx,
      'startRules',
      'Duplicate first-case queue.',
    )
    addDuplicateIssue(
      value.closeTriggers.map(
        (rule) => `${rule.sourceQueueId}:${rule.targetQueueId}`,
      ),
      ctx,
      'closeTriggers',
      'Duplicate close trigger relation.',
    )
    addDuplicateIssue(
      value.closeBlockers.map(
        (rule) => `${rule.blockedQueueId}:${rule.prerequisiteQueueId}`,
      ),
      ctx,
      'closeBlockers',
      'Duplicate close requirement relation.',
    )
    addDuplicateIssue(
      value.creationRequirements.map(
        (rule) => `${rule.targetQueueId}:${rule.prerequisiteQueueId}`,
      ),
      ctx,
      'creationRequirements',
      'Duplicate creation requirement relation.',
    )
  })

function addDuplicateIssue(
  keys: string[],
  ctx: z.RefinementCtx,
  path: string,
  message: string,
) {
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', message, path: [path] })
      return
    }
    seen.add(key)
  }
}

export type LimitsAndMdrSettings = z.infer<typeof limitsAndMdrSettingsSchema>
export type LinkDeadlineSettings = z.infer<typeof linkDeadlineSettingsSchema>
export type EmailSendingModeSettings = z.infer<
  typeof emailSendingModeSettingsSchema
>
export type MerchantPortalSettings = z.infer<
  typeof merchantPortalSettingsSchema
>
export type BusinessType = z.infer<typeof businessTypeSchema>
export type UpdateCaseFlowConfigurationInput = z.infer<
  typeof updateCaseFlowConfigurationSchema
>
