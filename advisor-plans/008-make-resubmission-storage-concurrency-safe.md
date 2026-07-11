# Plan 008: Make resubmission storage ownership concurrency-safe

> **Executor instructions**: Treat database and Drive as a distributed workflow. Never delete a folder unless the current attempt provably owns it.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/merchants/public-resubmission.routes.ts src/db/schema.ts drizzle tests/public`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: bug
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Concurrent uses of one resubmission link calculate the same submission number and folder, upload before token consumption, and let the loser delete that shared folder. A losing request can therefore destroy the winner’s committed documents.

## Current state

- `public-resubmission.routes.ts:349-359` derives `submissionIndex` by counting history.
- Lines 371-386 resolve a deterministic shared folder.
- Lines 401-426 upload files before the database transaction.
- Token consumption occurs at 560-573.
- Catch cleanup at 625-629 deletes the entire resolved folder.
- The storage provider supports file/folder deletion, while PostgreSQL provides the authoritative single-use token state.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Migration | `bun run db:generate` only after schema design is finalized | one reviewed forward migration |
| Tests | `bun test tests/public/resubmission-concurrency.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |

## Scope

**In scope**: resubmission route/service, `src/db/schema.ts`, one new forward migration if an attempt/reservation table or columns are required, storage fake enhancements, `tests/public/resubmission-concurrency.test.ts`.

**Out of scope**: changing form fields/response shape, Drive provider replacement, pagination, historical migration edits.

## Steps

1. Design an atomic reservation: claim the token in PostgreSQL before creating Drive objects, or create a unique attempt record with an ownership UUID and explicit states. Preserve the ability to roll back validation failures without consuming the link before a valid submission is ready. Document the chosen state machine in code comments.
   - **Verify**: concurrent valid requests yield one owner and one 410 before the loser uploads.
2. Use an attempt-unique folder component rather than history count as the storage identity. Retain a human-readable submission index as metadata only; allocate it transactionally if uniqueness matters.
   - **Verify**: storage fake records distinct ownership and no shared deletion target.
3. On failure, delete only file/folder IDs created by that attempt. On success, finalize documents, reviews, case state, history, and token state consistently; define recovery for upload-success/database-failure.
   - **Verify**: injected failure tests show no committed reference points to deleted content and no winning content is removed.
4. If schema changes, create a forward-only idempotent migration and test both clean migration and upgrade from `daf574b` schema. Never edit historical SQL.
   - **Verify**: migration applies once and re-running the migrator is a no-op.
5. Run concurrency tests at least 20 iterations and full checks.

## Done criteria

- [ ] At most one request uploads/finalizes per token.
- [ ] Cleanup deletes only attempt-owned objects.
- [ ] Successful database rows reference existing fake-storage objects.
- [ ] Migration and all tests/typecheck pass.

## STOP conditions

- The chosen design consumes valid tokens before recoverable upload failure without a documented retry state.
- Drive folder ownership cannot be proven from returned IDs.
- A migration would require rewriting existing migration history.

## Maintenance notes

This is a saga across PostgreSQL and Drive, not a single ACID transaction. Preserve explicit ownership and recovery states in future workflow changes.

