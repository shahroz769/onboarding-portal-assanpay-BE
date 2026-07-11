# Plan 009: Serialize MID Go-Live activation

> **Executor instructions**: Enforce idempotency in PostgreSQL, not with process-local locks. Preserve the current already-started response.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/cases/cases.service.ts src/db/schema.ts drizzle tests/public`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: bug
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Two activation transactions can both read an unused token and no Live case, insert duplicate cases, and then update the same token. The public action must be idempotent under simultaneous retries and multiple server processes.

## Current state

- `cases.service.ts:7273-7294` reads the token in a transaction without locking/claiming.
- Lines 7300-7311 implement idempotency only from that stale read.
- Lines 7342-7383 check for and then insert a Live case.
- Lines 7411-7417 consume the token unconditionally after creation.
- `schema.ts:538-582` has separate indexes but no uniqueness constraint for a merchant/queue case.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Tests | `bun test tests/public/mid-go-live-concurrency.test.ts` | all pass repeatedly |
| Typecheck | `bun run typecheck` | exit 0 |
| Migration | `bun run db:migrate` against disposable DB | applies once; second run no-op |

## Scope

**In scope**: `activateMidGoLive`, schema/migration only if needed, `tests/public/mid-go-live-concurrency.test.ts`.

**Out of scope**: Go-Live delay policy, email template, frontend page/response contract, global one-case-per-queue policy unless confirmed.

## Steps

1. Decide and encode the narrow invariant: one Live case per MID Go-Live token/merchant activation. Prefer an atomic token claim (`UPDATE ... WHERE consumed_at IS NULL RETURNING`) or row lock before side effects. Do not add a global `(queue_id, merchant_id)` unique constraint until existing workflow rules and data prove that all queues share it.
   - **Verify**: second concurrent transaction cannot enter case creation.
2. Preserve idempotent replies: after losing the claim, reload the token and return the committed `liveCaseId`/number when available; handle the short in-progress window deterministically (bounded retry or 409/425), not as a duplicate insert.
   - **Verify**: two simultaneous calls return compatible successful/already-started results and one case exists.
3. Ensure token claim, case creation/history, MID closure, and token linkage commit together. Add database constraint only if it expresses the confirmed narrow invariant.
   - **Verify**: injected transaction failure rolls back consumption and case creation.
4. Run the concurrent test at least 20 times and all checks.

## Done criteria

- [ ] Concurrent activation creates exactly one Live case and one creation-history entry.
- [ ] Retried activation returns the existing result.
- [ ] Failure rolls back all PostgreSQL state.
- [ ] No frontend API shape change.

## STOP conditions

- Existing production data contains legitimate multiple Live cases for one merchant and the proposed constraint would reject it.
- The implementation relies on an in-memory mutex.

## Maintenance notes

Review transaction ordering whenever activation gains external side effects. Database idempotency must remain authoritative across PM2 processes.

