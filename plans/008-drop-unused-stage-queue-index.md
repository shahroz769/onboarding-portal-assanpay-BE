# Plan 008: Validate and drop `cases_current_stage_queue_idx`

> **Executor instructions**: Address only PlanetScale recommendation #11. Do
> not apply the DDL directly to production.
>
> **Drift check**: `git diff --stat d3a7504..HEAD -- src/db/schema.ts drizzle/meta/_journal.json drizzle src/db/audit.ts`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED
- **Depends on**: Plan 001
- **Category**: migration / perf
- **Planned at**: commit `d3a7504`, 2026-08-22

## Why this matters

PlanetScale recommendation #11 reports
`cases_current_stage_queue_idx(current_stage_id, queue_id)` as unused. Removing
it reduces write amplification and storage, but it is also the child-column
shape of the composite stage/queue foreign key, so delete/update behavior must
be benchmarked before removal.

## Current state

- `src/db/schema.ts:662-665` declares the index.
- `src/db/schema.ts:711-715` declares the composite foreign key.
- `drizzle/0049_cases_current_stage_queue_index.sql` originally added it.
- Source search found no application query filtering `cases` by both columns;
  stage lookups query `queue_stages` instead.
- All other PlanetScale schema recommendations are applied; #11 is the only
  open recommendation.

## Scope

**In scope**: schema declaration, one new forward-only migration, journal entry,
and audit expectations.

**Out of scope**: dropping any other index, modifying the foreign key, or
running migrations against the production/runtime URL.

## Steps

### 1. Confirm non-use

Re-check open PRs, 30-day Insights index usage, `pg_stat_user_indexes`, and all
queries touching both columns. Benchmark representative case list/stage
queries and a queue-stage delete/update that exercises the FK on a development
branch.

**Verify**: evidence shows zero application use and acceptable FK-check cost
before removal.

### 2. Drop on a development branch

Add a new migration using `DROP INDEX CONCURRENTLY IF EXISTS` if the repository
migration runner supports non-transactional concurrent DDL; otherwise follow
the established safe migration convention. Remove the Drizzle declaration and
update the journal. Never edit migration 0049.

**Verify**: migrate only the development branch and confirm the FK remains
valid.

### 3. Re-benchmark

Repeat the same read and FK delete/update EXPLAIN/ANALYZE cases.

**Verify**: read plans are unchanged and FK maintenance remains within the
recorded acceptance threshold; `bun run db:audit` reports no unexpected
missing coverage on development.

## Done criteria

- A forward-only migration exists and was tested only on development.
- Before/after benchmark results are recorded.
- `bun run typecheck` passes.
- PlanetScale recommendation #11 is not manually marked applied until the
  production migration actually succeeds in a separately authorized run.

## STOP conditions

- The index has nonzero recent application use.
- FK delete/update degrades materially.
- The migration runner wraps migrations in a transaction incompatible with
  `CONCURRENTLY`; resolve the migration strategy before proceeding.

## Maintenance notes

Review the eventual production migration separately because DDL authorization
is outside this plan and outside the current local-only instruction.
