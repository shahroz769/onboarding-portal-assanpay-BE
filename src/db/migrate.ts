import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const migrationDatabaseUrl =
  Bun.env.MIGRATION_DATABASE_URL ?? Bun.env.DATABASE_URL

if (!migrationDatabaseUrl) {
  throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required.')
}

if (
  Bun.env.NODE_ENV === 'production' &&
  !Bun.env.MIGRATION_DATABASE_URL
) {
  throw new Error(
    'MIGRATION_DATABASE_URL is required in production. Use the direct PostgreSQL connection, not PgBouncer.',
  )
}

if (
  Bun.env.NODE_ENV === 'production' &&
  new URL(migrationDatabaseUrl).port === '6432'
) {
  throw new Error(
    'MIGRATION_DATABASE_URL points to PgBouncer (port 6432). Use the direct PostgreSQL URI on port 5432.',
  )
}

const migrationClient = postgres(migrationDatabaseUrl, {
  max: 1,
  application_name: 'onboarding-portal-migrations',
})

try {
  await migrate(drizzle(migrationClient), {
    migrationsFolder: './drizzle',
  })

  console.log('Migrations applied.')
} finally {
  await migrationClient.end()
}
