# Plan 011: Reconcile Google Drive files around agreement updates

> **Executor instructions**: Track new and prior file IDs explicitly. Never delete the file currently referenced by a committed database row.
>
> **Drift check**: `git diff --stat daf574b..HEAD -- src/modules/merchants/public-agreement.routes.ts src/lib/storage tests/public`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/002-establish-critical-integration-tests.md`
- **Category**: bug
- **Planned at**: commit `daf574b`, 2026-07-11

## Why this matters

Agreement uploads happen before the database transaction. Transaction failure leaves the new sensitive file orphaned, while successful conflict updates replace the stored Drive ID without deleting the superseded file.

## Current state

- `public-agreement.routes.ts:90-106` creates a folder and uploads before opening a transaction.
- Lines 109-139 upsert `caseFiles`; `onConflictDoUpdate` overwrites prior file metadata.
- Lines 153-166 may reject concurrent token consumption after upload.
- There is no outer cleanup handler and the prior Drive ID is not selected before replacement.
- The resubmission route demonstrates best-effort cleanup at `public-resubmission.routes.ts:625`, but its folder-wide deletion must not be copied.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Tests | `bun test tests/public/agreement-storage-lifecycle.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |

## Scope

**In scope**: `src/modules/merchants/public-agreement.routes.ts`; storage fake/provider only for a narrow delete contract; `tests/public/agreement-storage-lifecycle.test.ts`.

**Out of scope**: agreement file type/size policy, Drive provider migration, public response shape, token hashing (Plan 010).

## Steps

1. Load and retain the prior `caseFiles` Drive ID before upsert. Track the newly uploaded ID in attempt-local state.
   - **Verify**: fake storage/test can distinguish prior, new, and unrelated IDs.
2. Wrap post-upload work so any transaction/token failure deletes only the new upload. Cleanup failure must be logged without secrets and must not replace the original domain error.
   - **Verify**: injected DB failure leaves prior file/reference intact and requests deletion of only the new ID.
3. After a successful commit, delete the prior file if it differs from the new committed ID. If that cleanup fails, retain the successful response but emit structured operational evidence sufficient for reconciliation.
   - **Verify**: success points DB at new file and deletes prior; same-ID and first-upload cases do not delete the current file.
4. Add concurrent token tests: one commit, loser’s upload removed, winner’s file retained.
   - **Verify**: focused test passes repeatedly; full checks pass.

## Done criteria

- [ ] Failed/racing uploads remove only their own new file.
- [ ] Successful replacement removes the superseded file after commit.
- [ ] Committed references are never deleted.
- [ ] Tests cover cleanup failures as well as successes.

## STOP conditions

- Storage delete semantics cannot distinguish files from folders.
- Existing rows may share a Drive file ID across cases; establish reference ownership before deleting.

## Maintenance notes

Post-commit deletion remains eventually consistent. Consider a durable cleanup outbox if operational evidence shows repeated Drive failures.

