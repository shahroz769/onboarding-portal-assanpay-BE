# Production database operations

## Connections

- Local development uses Neon through `DATABASE_URL`.
- The EC2 application uses the PlanetScale PgBouncer URI (port 6432) through
  `DATABASE_URL`.
- Production migrations use a separate PlanetScale direct URI (port 5432)
  through `MIGRATION_DATABASE_URL`.
- Store both production values only in the protected EC2 environment. Never put
  either value in GitHub workflow commands or frontend/Cloudflare variables.

Use a least-privilege application role for `DATABASE_URL` and a separate role
with DDL permissions for `MIGRATION_DATABASE_URL`.

## First production initialization

1. Configure both connection variables on EC2 and ensure the PlanetScale TLS
   parameters remain in the URIs.
2. Run `bun install --frozen-lockfile` and `bun run check`.
3. Run `NODE_ENV=production bun run db:migrate` once.
4. Run it a second time to confirm that replay is idempotent.
5. Start/reload PM2 and require `GET /health/ready` to return HTTP 200.
6. Smoke-test registration/login, merchant submission, queues, dashboard reads,
   and one update before opening the Cloudflare frontend.

## Every schema change

1. Edit `src/db/schema.ts` locally.
2. Run `bun run db:generate`; never generate migrations on EC2.
3. Review the SQL for destructive operations, locks, enum changes, and required
   backfills. Commit schema, SQL, and Drizzle metadata together.
4. Apply and test it on Neon. Also replay the full history on an empty test
   database before merging.
5. Merge to `main`. Deployment checks the history, applies pending migrations
   over the direct connection, and reloads PM2 only after migration success.

Do not use `drizzle-kit push` in production. Never modify or delete a migration
that has been applied. Correct mistakes with a new forward migration. Use
expand/backfill/switch/contract releases for destructive or incompatible changes.

## Legacy migration audit

The following unjournaled files are legacy alternatives whose effective changes
are covered by journaled migrations: `0005_cases_priority.sql`,
`0007_notifications.sql`, `0008_resubmission_and_email.sql`, and
`0027_physical_agreement_queue.sql`. They are excluded from Drizzle replay and
should not be run manually. The history check prevents new unjournaled migration
files from being introduced.
