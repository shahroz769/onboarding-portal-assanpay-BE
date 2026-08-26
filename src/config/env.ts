import { z } from 'zod'

const defaultCookieSecure = Bun.env.NODE_ENV === 'production' ? 'true' : 'false'
const emailAddressSchema = z.string().email()
const corsOriginSchema = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().url()).min(1))
  .transform((origins) => origins.map((origin) => new URL(origin).origin))
const domainSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i,
  )

function normalizeEmailAddressOrDomain(value: string, ctx: z.RefinementCtx) {
  const trimmed = value.trim()
  if (emailAddressSchema.safeParse(trimmed).success) return trimmed
  if (domainSchema.safeParse(trimmed).success) return `support@${trimmed}`

  ctx.addIssue({
    code: 'custom',
    message: 'Expected an email address or domain.',
  })
  return z.NEVER
}

const envSchema = z.object({
  APP_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(120)
    .default(10),
  DATABASE_IDLE_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .default(20),
  CASE_FLOW_WORKER_POLL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(1_000),
  CASE_FLOW_WORKER_IDLE_POLL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(60_000),
  CASE_FLOW_WORKER_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(5),
  CASE_FLOW_WORKER_DEGRADED_AFTER_ATTEMPTS: z.coerce
    .number()
    .int()
    .positive()
    .max(20)
    .default(Number(Bun.env.CASE_FLOW_WORKER_MAX_ATTEMPTS ?? 8)),
  CASE_FLOW_WORKER_RETRY_BASE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1_000)
    .default(30_000),
  CASE_FLOW_WORKER_RETRY_MAX_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(15 * 60_000),
  CASE_FLOW_WORKER_BLOCKED_RETRY_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1_000)
    .default(6 * 60 * 60 * 1_000),
  CASE_FLOW_WORKER_RETRY_JITTER_PERCENT: z.coerce
    .number()
    .int()
    .min(0)
    .max(50)
    .default(10),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  ALLOW_SUPER_ADMIN_REGISTRATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  COOKIE_DOMAIN: z.string().min(1).optional(),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default(defaultCookieSecure)
    .transform((value) => value === 'true'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CORS_ORIGIN: corsOriginSchema.default(['http://localhost:5173']),
  TRUST_PROXY_HEADERS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  GOOGLE_DRIVE_CLIENT_EMAIL: z.string().email().optional(),
  GOOGLE_DRIVE_PRIVATE_KEY: z.string().min(1).optional(),
  GOOGLE_DRIVE_PARENT_FOLDER_ID: z.string().min(1).optional(),
  GOOGLE_DRIVE_PARENT_FOLDER_ID_PUBLIC: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z
    .string()
    .min(1)
    .default('AssanPay Onboarding <onboarding@tech.assanpaybd.com>'),
  EMAIL_REPLY_TO: z
    .string()
    .min(1)
    .transform(normalizeEmailAddressOrDomain)
    .optional(),
  EMAIL_TEST_TO: z.string().email().optional(),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
})

export const env = envSchema.parse(Bun.env)

if (env.COOKIE_SAME_SITE === 'none' && !env.COOKIE_SECURE) {
  throw new Error('COOKIE_SAME_SITE=none requires COOKIE_SECURE=true.')
}
