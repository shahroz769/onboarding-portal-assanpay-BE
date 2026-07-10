import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const directDatabaseUrl = Bun.env.DIRECT_DATABASE_URL

if (!directDatabaseUrl) {
  throw new Error(
    'DIRECT_DATABASE_URL is required for migrations. Use the direct PlanetScale connection (port 5432), not PgBouncer.',
  )
}

// Schema changes should bypass PgBouncer. A single direct connection also
// keeps migration commands from consuming the application's connection pool.
const migrationClient = postgres(directDatabaseUrl, {
  max: 1,
  prepare: false,
})
const migrationDb = drizzle(migrationClient)

try {
  await migrate(migrationDb, {
    migrationsFolder: './drizzle',
  })
} finally {
  await migrationClient.end()
}

console.log('Migrations applied.')
