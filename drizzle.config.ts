import { defineConfig } from 'drizzle-kit'

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
})
