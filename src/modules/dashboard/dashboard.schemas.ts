import * as z from 'zod'

export const dashboardRangeKeys = [
  'today',
  '7d',
  '30d',
  '90d',
  'mtd',
  'custom',
] as const

export type DashboardRangeKey = (typeof dashboardRangeKeys)[number]

export const dashboardQuerySchema = z
  .object({
    range: z.enum(dashboardRangeKeys).default('30d'),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .refine(
    (value) =>
      value.range !== 'custom' || (Boolean(value.from) && Boolean(value.to)),
    { error: 'Custom range requires both from and to dates.' },
  )

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>

export const applyPortalMidLimitsSchema = z.strictObject({
  portalMids: z.array(z.coerce.number().int().positive()).min(1),
  category: z.enum(['custom_wordpress', 'shopify', 'internal']),
})

export type ApplyPortalMidLimitsInput = z.infer<
  typeof applyPortalMidLimitsSchema
>

export const pendingPortalMidKinds = ['portal', 'internal'] as const

export type PendingPortalMidKind = (typeof pendingPortalMidKinds)[number]

export const pendingPortalMidsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export type PendingPortalMidsQuery = z.infer<
  typeof pendingPortalMidsQuerySchema
>

// Omit midKind to get every pending MID.
export const pendingPortalMidValuesQuerySchema = z.object({
  midKind: z.enum(pendingPortalMidKinds).optional(),
})

export type PendingPortalMidValuesQuery = z.infer<
  typeof pendingPortalMidValuesQuerySchema
>

export const awaitingPhysicalAgreementsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export type AwaitingPhysicalAgreementsQuery = z.infer<
  typeof awaitingPhysicalAgreementsQuerySchema
>
