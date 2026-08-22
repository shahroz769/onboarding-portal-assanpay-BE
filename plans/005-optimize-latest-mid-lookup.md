# Plan 005: Optimize the latest MID credentials lookup

> **Executor instructions**: Optimize only fingerprint `8a47fdbbb030`. Preserve
> the exact latest successful `mid_creation_saved` semantics.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/modules/cases/case-detail-lookups.ts src/db/schema.ts drizzle/meta/_journal.json drizzle`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001
- **Category**: perf / migration
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

This lookup read 17,022 rows to return 134 across 558 executions, with a
21.8 ms maximum. The current index begins with `case_id`, while the query begins
from `merchant_id` and joins all matching cases before filtering history.

## Current state

- `src/modules/cases/case-detail-lookups.ts:484-497` joins `case_history` to
  `cases`, filters `cases.merchant_id` and action, then orders history globally.
- `src/db/schema.ts:844-851` provides `(case_id, action, created_at)` and
  `(case_id, created_at, id)` indexes.
- `src/db/schema.ts:654-658` provides `(merchant_id, created_at, id)` on cases.

## Scope

**In scope**: `getMidCreationCredentials`, focused tests, and at most one new
forward-only migration if measurement proves it necessary.

**Out of scope**: MID dashboard CTEs, changing JSON structure, backfilling a
new projection table, or changing credential validation.

## Steps

### 1. Baseline representative distributions

On a development branch, seed merchants with many cases and history events.
Capture EXPLAIN for the current query using low-, median-, and high-history
merchants.

**Verify**: record actual rows at each node, buffers, and latency.

### 2. Test a two-stage query rewrite

First identify relevant case IDs for the merchant using the existing
merchant-created index, then query `case_history` for those IDs/action ordered
by `created_at DESC, id DESC LIMIT 1`. Preserve one deterministic tie-breaker.

**Verify**: characterization tests return byte-equivalent credentials for
missing history, one case, multiple cases, invalid details, and tied times.

### 3. Add an index only if EXPLAIN proves it

If `(case_id, action, created_at)` still sorts or scans excessively, test a
candidate with `id DESC` on the development branch. Add a new migration and
journal entry only when the measured plan materially improves. Never rewrite
an existing migration.

**Verify**: before/after EXPLAIN shows lower actual rows/buffers for the same
parameters. If improvement is below 2x and p99 stays below 20 ms, keep only the
query rewrite or reject the change.

## Done criteria

- `bun test` and `bun run typecheck` pass.
- Equivalent results are proven.
- Any migration is forward-only and was never run against production.
- One fingerprint/query pattern changed.

## STOP conditions

- Correct semantics require knowing which case close outcome is authoritative.
- The rewrite performs worse for any representative distribution.
- A new index duplicates an existing prefix.

## Maintenance notes

Plan 006 may later reuse a proven latest-MID access pattern, but must benchmark
its separate dashboard fingerprint independently.
