# Plan 002: Remove unnecessary Postgres.js array-type discovery

> **Executor instructions**: Optimize only fingerprint `b8199c4a035d`. Benchmark
> on a development database before editing. Update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/db/client.ts src/db/schema.ts src`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: Plan 001
- **Category**: perf
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

Postgres.js runs a `pg_catalog.pg_type` query on every new connection. Over
seven days it executed 982 times, read 1,474,964 catalog rows, transferred
8.61 MB, and consumed 494 ms. In the latest hour it was the largest remaining
query by total time (34 calls, 15.2 ms). The likely fix is `fetch_types: false`,
but only if every application array/custom type still decodes correctly.

## Current state

- `src/db/client.ts:12-19` configures the shared client and leaves
  `fetch_types` at its default `true`.
- `node_modules/postgres/README.md:1136-1142` states the query discovers table
  and array types and can be disabled with `fetch_types: false`.
- The codebase uses PostgreSQL arrays, JSONB, UUID, enum, and timestamp columns;
  these require round-trip characterization before disabling discovery.

## Scope

**In scope**: `src/db/client.ts` and a focused database integration test.

**Out of scope**: pool-size changes, schema changes, prepared statements,
production EXPLAIN, or unrelated query rewrites.

## Steps

### 1. Record baseline

On a migrated development branch, open a fresh direct client and run one
representative query for every used type family. Record returned JavaScript
types. Capture `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the catalog
fingerprint and measure connection-to-first-query wall time across at least 30
fresh connections.

**Verify**: the report contains median/p95 startup time and exact type
round-trip assertions.

### 2. Disable discovery

Set `fetch_types: false` in `src/db/client.ts`. Do not alter `prepare: false`.

**Verify**: repeat the 30-connection benchmark; the catalog fingerprint is
absent and all type assertions match baseline.

### 3. Validate application behavior

Exercise reads and writes involving array, JSONB, enum, UUID, numeric, date,
and timestamptz fields.

**Verify**: `bun test` and `bun run typecheck` exit 0.

## Done criteria

- The `pg_type` fingerprint is absent from the development run.
- Returned values and stored values match the baseline.
- Startup median/p95 and rows-read improvement are recorded.
- Only this query pattern was optimized.

## STOP conditions

- Any type changes representation or fails to round-trip.
- The benchmark cannot create isolated fresh connections.
- Current Postgres.js behavior differs from its installed documentation.

## Maintenance notes

Re-run the type test whenever a custom PostgreSQL type or array column is
introduced.
