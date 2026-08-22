# Plan 004: Add keyset pagination to case history

> **Executor instructions**: Optimize only fingerprint `aa862a3e60d6` and its
> frontend consumer. Preserve chronological rendering and authorization.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/modules/cases/case-comments.service.ts src/modules/cases/cases.routes.ts src/modules/cases/cases.schemas.ts ../onboarding-portal-assanpay-FE/src/apis/cases.ts ../onboarding-portal-assanpay-FE/src/hooks/use-case-detail-query.ts ../onboarding-portal-assanpay-FE/src/features/cases/case-detail/case-history-timeline.tsx`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001
- **Category**: perf
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

Case history is returned without a limit. The fingerprint ran 745 times,
reading 10,349 rows and transferring 758,071 bytes in seven days. It is fast
today, but its work grows forever with each case and the detail page prefetches
it automatically.

## Current state

- `src/modules/cases/case-comments.service.ts:238-279` performs authorization,
  an existence query, then returns the complete non-comment history ordered by
  `created_at`, action precedence, and `id` descending.
- `src/db/schema.ts:847-851` has `(case_id, created_at, id)`.
- Frontend `src/hooks/use-case-detail-query.ts:84-103` prefetches one complete
  array and `src/apis/cases.ts:587-592` models an array response.

## Scope

**In scope**: history query schema/service/route and frontend history API,
query hook, and timeline loading behavior.

**Out of scope**: comments, history event contents, sanitizer behavior,
authorization rules, or other case-detail queries.

## Steps

### 1. Baseline

Seed a development case with at least 500 varied history events, including
identical timestamps and paired rejection/email actions. Capture EXPLAIN and
payload bytes for the unbounded query.

**Verify**: baseline ordering matches the current UI.

### 2. Add a stable cursor

Add validated `limit` and opaque cursor inputs. The cursor must preserve the
existing three-part order: `created_at`, computed action precedence, and `id`.
Fetch `limit + 1` and return a page envelope.

**Verify**: tests prove no gaps/duplicates across tied timestamps and paired
events, and unauthorized agents still receive the same errors.

### 3. Update the frontend

Use an infinite query and append older events. Preserve the initial newest
page and add an explicit load-more interaction; do not silently hide history.

**Verify**: frontend tests cover initial render, next page, empty history, and
the end of pagination.

### 4. Re-benchmark

Use the same case and first-page parameters.

**Verify**: the plan uses `case_history_case_created_idx`, returns at most
`limit + 1`, and transfers fewer bytes than baseline.

## Done criteria

- Backend `bun test` and `bun run typecheck` pass.
- Frontend `bun run test`, `bun run lint`, and `bun run format` pass; no build.
- Before/after EXPLAIN and payload results are recorded.

## STOP conditions

- The action-precedence cursor cannot be expressed without unstable ordering.
- Product requires the complete history for export/audit in this endpoint.
- The existing index is not chosen on representative data; investigate a
  matching expression/index in a separate schema plan.

## Maintenance notes

Any new action with special same-timestamp precedence must update both cursor
encoding and ordering tests.
