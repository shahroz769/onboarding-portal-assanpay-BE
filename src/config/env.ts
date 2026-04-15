import { z } from "zod";

const defaultCookieSecure = Bun.env.NODE_ENV === "production" ? "true" : "false";

const envSchema = z.object({
  APP_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  ALLOW_ADMIN_REGISTRATION: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  COOKIE_DOMAIN: z.string().min(1).optional(),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default(defaultCookieSecure)
    .transform((value) => value === "true"),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:5173"),
});

export const env = envSchema.parse(Bun.env);
