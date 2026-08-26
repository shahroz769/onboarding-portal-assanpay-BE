# AssanPay Onboarding Portal Backend

Bun/Hono API for merchant onboarding, queue-based case workflows, employee access, notifications, email delivery, and Google Drive document storage.

## Local setup

Requires Bun 1.3.14+ and PostgreSQL/PlanetScale Postgres.

```sh
bun install --frozen-lockfile
```

Copy `.env.example` to `.env` and replace placeholders:

- `DATABASE_URL`: pooled runtime connection, normally PgBouncer on port 6432.
- `DIRECT_DATABASE_URL`: direct port 5432 connection for migrations and Drizzle tooling.
- `DATABASE_POOL_MAX`: maximum Postgres.js connections per backend process (default `10`).
- `DATABASE_CONNECT_TIMEOUT_SECONDS`: connection establishment timeout (default `10`).
- `DATABASE_IDLE_TIMEOUT_SECONDS`: close unused client connections after this interval (default `20`).
- `CASE_FLOW_WORKER_*`: polling, batch, and bounded exponential retry controls
  for durable follow-up case creation. The defaults poll every second while
  active, back off to one minute while idle, and process five jobs per cycle.
  After eight failed attempts a job is reported as degraded, but it continues
  retrying automatically at the bounded maximum interval until it succeeds.
- JWT secrets: distinct random values of at least 32 characters.
- CORS, cookie, and `PUBLIC_APP_URL`: configure for the separately hosted frontend/backend.
- `TRUST_PROXY_HEADERS`: enable only behind a proxy that overwrites forwarding headers.
- Google Drive and Resend variables: required by their production workflows.

Never expose backend credentials to the frontend.

For Neon development, prefer the pooled `-pooler` URL for `DATABASE_URL` and
the non-pooler URL for `DIRECT_DATABASE_URL`. For PlanetScale production, use
the PgBouncer URL on port 6432 for runtime traffic and the direct port 5432 URL
only for migrations. Prepared statements remain disabled for transaction-mode
PgBouncer compatibility.

## Commands

```sh
bun run dev
bun run typecheck
bun run db:migrate
bun run db:audit
bun run db:generate
```

The API defaults to `http://localhost:3000`; database and case-flow worker
readiness are at `/health/db`. The worker health payload reports pending jobs,
degraded retrying jobs, the oldest pending timestamp, and the last cycle.
Admins can inspect degraded jobs at `GET /api/cases/flow-jobs/failed` and request
an immediate retry with `POST /api/cases/flow-jobs/:jobId/retry`; this is optional
because retries continue automatically.
Run `db:audit` only against a migrated development or staging database. It is
read-only and checks duplicate indexes, foreign-key index coverage, constraint
validation, and the query-critical indexes introduced by the optimization migration.

## Architecture

- `src/index.ts`: Hono app, CORS, public limits, routes, cleanup.
- `src/config/env.ts`: validated environment contract.
- `src/db`: Drizzle schema, client, migrations.
- `src/middleware`: authentication, roles, errors.
- `src/modules/auth`: JWT sessions and password links.
- `src/modules/cases`: workflows, queue access, history, Go-Live.
- `src/modules/merchants`: merchant and public multipart workflows.
- `src/modules/configuration`: workflow configuration.
- `src/modules/notifications`: notifications and SSE.
- `src/lib/storage`: Google Drive integration.

## Database and deployment

Migrations are forward-only. Add a new migration under `drizzle/`, update the journal, and run `bun run db:migrate` with the direct URL. Never rewrite a migration that may have reached another environment.

Pushes to `main` perform a frozen installation and typecheck, migrate PlanetScale
through `DIRECT_DATABASE_URL`, restart PM2, and poll `/health/db`. Deployments are
serialized, and a failed deployment restores the previous application checkout.
Migrations are not reversed, so every production migration must remain compatible
with the previous application version until the new version passes its health check.

The frontend is maintained separately at `../onboarding-portal-assanpay-FE`.
