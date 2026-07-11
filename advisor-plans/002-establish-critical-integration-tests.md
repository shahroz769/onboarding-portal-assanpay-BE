# Plan 002: Establish integration coverage for critical backend invariants

> **Executor instructions**: Follow every step and verification gate. Use only a disposable test database. Modify only in-scope files. Update `advisor-plans/README.md` when complete.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- package.json bun.lock src/index.ts src/config/env.ts src/db/client.ts tests`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `advisor-plans/001-restore-verification-baseline.md`
- **Category**: tests
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Custom JWT/session rotation, queue authorization, public single-use links, PostgreSQL transactions, and Google Drive side effects currently have zero tests. This plan creates one repeatable Bun test command and enough real-database characterization coverage for later security and concurrency fixes to be made safely.

## Current state

- `package.json:3-7` has no test script; `bun test` reports “No tests found”.
- `src/config/env.ts:33-70` parses required runtime variables at module import.
- `src/index.ts:23` constructs the Hono app and lines 98-100 start cleanup immediately, making imports side-effectful.
- `src/db/client.ts:6-37` owns singleton PostgreSQL/Drizzle clients with no test lifecycle hook.
- `src/modules/auth/auth.service.ts:217-275` contains the atomic refresh-token rotation invariant.
- Repository style uses Bun, Hono, Drizzle, Zod, and `AppError`; tests must exercise the Hono boundary and real transactions rather than mock Drizzle chains.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | exit 0; no skipped critical suites |
| Focused | `bun test tests/auth tests/authorization` | all pass |

## Scope

**In scope**: `package.json`, `bun.lock`, `src/index.ts` or a new `src/app.ts`, `src/config/env.ts`, `src/db/client.ts`, new `tests/**`, and a test-only storage/provider seam if strictly required.

**Out of scope**: changing production auth semantics, solving findings 1-10, connecting tests to a non-disposable database, frontend changes.

## Steps

1. Separate app construction from process startup: export a Hono app/factory without starting timers; retain cleanup scheduling only in the runtime entry point.
   - **Verify**: importing the app in a test exits without an open interval.
2. Add a `test` script using Bun’s runner and a test setup that requires `TEST_DATABASE_URL`. Refuse to run if it equals `DATABASE_URL` or lacks an explicit test marker agreed by the repository (database name/suffix). Provide placeholder JWT/CORS/cookie settings without recording secrets.
   - **Verify**: with no test URL, `bun run test` fails before destructive setup with a clear disposable-database message.
3. Add deterministic migration/reset helpers and close the PostgreSQL client after the suite. Never truncate or migrate the configured development/production URL.
   - **Verify**: run the suite twice; both runs pass and exit without hanging.
4. Add integration suites for login failure/success, access-token session-version invalidation, refresh rotation and replay rejection, logout, inactive/deleted users, representative role middleware, and selected/all queue view/work access.
   - **Verify**: `bun test tests/auth tests/authorization` passes.
5. Add reusable factories for users, queues, merchants, cases, tokens, and a deterministic storage fake interface for later plans. Do not couple tests to generated UUID literals or execution order.
   - **Verify**: `bun run typecheck && bun run test` exits 0.

## Test plan

Tests are the product of this plan. Assert response codes and persisted state, especially token status/replacement linkage and authorization denials. At least one test must prove a rotated refresh token cannot be replayed and one must prove a selected-scope agent cannot view/work an unassigned queue.

## Done criteria

- [ ] One `bun run test` command runs all backend tests.
- [ ] Test setup cannot target the normal `DATABASE_URL` accidentally.
- [ ] App imports have no timer/server side effects.
- [ ] Auth and queue-access suites use real PostgreSQL and pass twice consecutively.
- [ ] `bun run typecheck` passes.

## STOP conditions

- No disposable PostgreSQL database can be provided.
- The only viable setup would read or overwrite the checked-in `.env`.
- A storage seam requires changing production workflow behavior rather than dependency construction only.

## Maintenance notes

Every subsequent bug plan must add its regression case to this harness. Keep external services faked at the provider boundary while retaining real database transactions.

