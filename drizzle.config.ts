import { defineConfig } from 'drizzle-kit'

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL

if (!directDatabaseUrl) {
  throw new Error(
    'DIRECT_DATABASE_URL is required to use drizzle-kit. Use a direct, non-pooler connection.',
  )
}

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: directDatabaseUrl,
  },
})
