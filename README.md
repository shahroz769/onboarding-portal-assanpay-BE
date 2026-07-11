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
- JWT secrets: distinct random values of at least 32 characters.
- CORS, cookie, and `PUBLIC_APP_URL`: configure for the separately hosted frontend/backend.
- `TRUST_PROXY_HEADERS`: enable only behind a proxy that overwrites forwarding headers.
- Google Drive and Resend variables: required by their production workflows.

Never expose backend credentials to the frontend.

## Commands

```sh
bun run dev
bun run typecheck
bun run test
bun run db:migrate
bun run db:generate
```

The API defaults to `http://localhost:3000`; database readiness is at `/health/db`.

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

Pushes to `main` run frozen installation, typecheck, and tests. Deployment checks out the triggering SHA on EC2, migrates, restarts PM2, and polls `/health/db`. If health fails after a schema change, deploy a forward repair rather than blindly reversing production migrations.

The frontend is maintained separately at `../onboarding-portal-assanpay-FE`.
