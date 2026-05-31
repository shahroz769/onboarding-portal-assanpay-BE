import { z } from 'zod'

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
    { message: 'Custom range requires both from and to dates.' },
  )

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>
