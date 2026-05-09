import { z } from 'zod'

export const linkDeadlineSettingsSchema = z
  .object({
    passwordResetHours: z.coerce.number().int().min(1).max(720),
    newPasswordSetHours: z.coerce.number().int().min(1).max(720),
    agreementLinkHours: z.coerce.number().int().min(1).max(720),
    documentsReviewResubmissionHours: z.coerce.number().int().min(1).max(720),
    goLiveAvailabilityHours: z.coerce.number().int().min(1).max(720),
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

export type LimitsAndMdrSettings = z.infer<typeof limitsAndMdrSettingsSchema>
export type LinkDeadlineSettings = z.infer<typeof linkDeadlineSettingsSchema>
export type BusinessType = z.infer<typeof businessTypeSchema>
