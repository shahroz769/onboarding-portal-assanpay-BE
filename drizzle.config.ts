import { defineConfig } from 'drizzle-kit'

const directDatabaseUrl = process.env.DIRECT_DATABASE_URL

if (!directDatabaseUrl) {
  throw new Error(
    'DIRECT_DATABASE_URL is required to use drizzle-kit. Use the direct PlanetScale connection (port 5432).',
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
