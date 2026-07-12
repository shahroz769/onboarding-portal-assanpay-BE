# Plan 002: Make case state transitions atomic and consistent

> **Executor instructions**: Preserve API responses and authorization rules.
> Do not add tests or run frontend builds.
>
> **Drift check**: `git diff --stat 9d2ee9d..HEAD -- src/modules/cases src/db/schema.ts drizzle`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, migration
- **Planned at**: commit `9d2ee9d`, 2026-07-12

## Why this matters

Cases currently store both status and stage, but generic mutations can update
only status and concurrent transitions validate stale state. PostgreSQL also
cannot prove that a case's stage belongs to its queue.

## Current state

- `cases.service.ts:updateCaseStatus` reads before its transaction and updates
  with only `cases.id` in the predicate.
- `advanceStage` and ownership mutations already update stage and status together;
  use that as the target convention.
- `schema.ts` has independent foreign keys for `cases.queue_id` and
  `cases.current_stage_id`.

## Scope

**In scope**: case transition helpers, status/advance/assignment/closure paths,
case-flow prerequisite checks, schema, one forward migration, API error mapping.

**Out of scope**: queue-stage CRUD, flow editor contract, Drive, frontend, tests.

## Steps

1. Add a unique constraint on `queue_stages(id, queue_id)` and a composite
   foreign key from `cases(current_stage_id, queue_id)`. Preflight the migration
   and fail with a clear exception if mismatches exist; do not silently rewrite them.
2. Create one transaction-scoped transition function that locks the case row,
   reloads its stage/queue, validates work access and ownership, derives status
   from the target stage, checks close blockers, updates with a stale-state guard,
   and writes history in the same transaction.
3. Route generic status updates through an explicit stage selection. Reject any
   requested status that maps ambiguously to multiple stages instead of guessing.
4. Move prerequisite reads inside the same transaction. Lock rows in stable ID
   order where multiple cases participate; return `409` for a lost race.
5. Replace stage-by-ID lookups with `(stage ID, queue ID)` predicates.

## Verification

- `bun run typecheck` exits 0.
- `bunx drizzle-kit check` exits 0.
- `rg -n "where: eq\(queueStages.id" src/modules/cases` returns no unsafe
  stage-only transition lookup.
- `git diff --check` exits 0.

## Done criteria

- Status and stage cannot disagree after any mutation.
- PostgreSQL rejects a stage from another queue.
- Concurrent transitions cannot both commit from the same prior state.
- Queue view/work and documented owner checks remain enforced.

## STOP conditions

- Stop if existing data violates stage/queue ownership; report the rows by IDs
  only and request a repair decision.
- Stop if preserving an endpoint requires an ambiguous status-to-stage mapping.
- Do not add tests; record test cases for the deferred test plan instead.

