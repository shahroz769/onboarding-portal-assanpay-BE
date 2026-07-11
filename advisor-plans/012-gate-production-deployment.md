# Plan 012: Gate backend deployment on verification, migrations, and health

> **Executor instructions**: Treat deployment and schema changes as production-sensitive. Do not add or expose secret values.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- .github/workflows/deploy.yml package.json README.md src/index.ts src/db/migrate.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `advisor-plans/001-restore-verification-baseline.md`, `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: dx
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Every push to `main` currently SSHes into EC2, pulls a mutable checkout, runs an unconstrained install, and restarts PM2. It does not typecheck, test, run migrations, verify health, serialize deployments, or define rollback behavior.

## Current state

- `.github/workflows/deploy.yml:3-6` deploys every main push.
- Lines 22-26 run only `git pull origin main`, `bun install`, and `pm2 restart onboarding-backend`.
- `package.json:6` provides `db:migrate`; `src/db/migrate.ts:5-26` requires a direct connection and closes it safely.
- `src/index.ts:46-53` exposes `/health/db` but it is not checked during deploy.
- README documents database URLs but no deployment/migration/rollback procedure.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Workflow syntax | parse workflow with available YAML/action linter | exit 0 |
| Backend checks | `bun run typecheck && bun run test` | exit 0 before deploy job |
| Install | `bun install --frozen-lockfile` | exit 0 |

## Scope

**In scope**: `.github/workflows/deploy.yml`, `package.json` only for aggregate check scripts, backend deployment section in `README.md`, narrowly improved health endpoint only if needed for readiness.

**Out of scope**: changing EC2/PM2 provider, editing GitHub secret values, frontend deployment, publishing issues, automatic destructive rollback of migrations.

## Steps

1. Split CI verification from deploy. Checkout, install frozen dependencies, run typecheck and tests on GitHub’s runner; make deploy depend on success. Add concurrency so a newer main deployment cancels/queues safely rather than interleaving SSH sessions.
   - **Verify**: workflow dependency graph shows deploy cannot start after a failed check.
2. Deploy the exact triggering SHA, not an unconstrained `git pull`. On the host fetch and checkout/reset only through an explicitly safe release mechanism; preserve environment files outside version control. Avoid destructive branch commands unless the operator approves the release-directory approach.
   - **Verify**: deployed revision is printed and equals `${{ github.sha }}` without exposing secrets.
3. Run `bun install --frozen-lockfile`, then `bun run db:migrate` with `DIRECT_DATABASE_URL`, then restart/reload PM2. Document that migrations must be backward-compatible because application rollback cannot generally undo schema changes.
   - **Verify**: a staging/dry-run deployment applies migrations before process restart.
4. Poll `/health/db` with a bounded timeout after restart. On failure, surface logs and fail the workflow; define the approved application rollback procedure without automatically rolling back schema.
   - **Verify**: simulated unhealthy service makes the workflow fail.
5. Document required secret names by type only, release order, health check, and manual rollback.
   - **Verify**: no credential values are added; workflow lint/check passes.

## Test plan

Use workflow validation plus a staging or local SSH target if available. Do not test against production as the first execution. Simulate check failure, migration failure, PM2 failure, health timeout, and concurrent pushes.

## Done criteria

- [ ] Deploy requires passing typecheck/tests.
- [ ] Frozen lockfile and exact SHA are used.
- [ ] Forward migrations run before restart.
- [ ] Health failure fails deployment with actionable output.
- [ ] Deployment concurrency and rollback documentation exist.

## STOP conditions

- No staging target or safe dry-run is available for the first migration-enabled deploy.
- Production migrations are not backward-compatible with the currently running process.
- Exact-SHA deployment would overwrite uncommitted server-local files; inventory them before proceeding.

## Maintenance notes

Database rollbacks require forward repair, not blind down migrations. Review host state drift and move toward immutable release directories in a later infrastructure plan.

