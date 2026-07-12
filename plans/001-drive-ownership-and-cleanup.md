# Plan 001: Make Google Drive ownership and cleanup safe

> **Executor instructions**: Follow this plan exactly. Preserve existing user
> changes. Do not add tests, run frontend builds, expose environment values, or
> migrate the normal runtime database.
>
> **Drift check**: `git diff --stat 9d2ee9d..HEAD -- src/lib/storage src/modules/merchants src/modules/cases src/db drizzle`
> Compare every referenced symbol with the live tree before editing.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug, security, migration
- **Planned at**: commit `9d2ee9d`, 2026-07-12

## Why this matters

Concurrent first uploads can create duplicate merchant roots. More seriously,
a losing public resubmission can delete a shared folder containing the winning
submission. Cleanup must be based on explicit attempt ownership, never folder
name or an ID returned by find-or-create.

## Current state

- `src/modules/merchants/merchant-drive-folders.ts:78` reads a merchant root ID,
  creates a Drive root, then writes the ID without serialization.
- `src/modules/merchants/public-resubmission.routes.ts:359-630` allocates a
  submission number from history, uses find-or-create paths, atomically consumes
  the token only after uploads, then deletes the whole returned folder on error.
- `src/lib/storage/google-drive.ts:129` implements search-then-create.
- `src/lib/storage/google-drive.ts:234,336` reports moved objects as zero bytes.
- Upload validators trust extension and browser MIME metadata.

## Scope

**In scope**: storage provider/types, merchant Drive folder helpers, public
resubmission/agreement uploads, authenticated case upload paths, Drizzle schema,
one new forward migration and journal entry, upload schemas.

**Out of scope**: email delivery, queue behavior, frontend, test files, deleting
historical successful objects, changing public response shapes.

## Steps

1. Add a `storage_objects` ownership ledger with provider object ID, object kind
   (`file`/`folder`), merchant/case owner, visibility, attempt UUID, lifecycle
   (`provisioning`, `current`, `superseded`, `failed`), parent object ID,
   metadata, and timestamps. Add unique provider-object identity and owner/attempt
   indexes in a new forward migration.
   **Verify**: `bunx drizzle-kit check` exits 0.
2. Replace merchant-root check-then-create with a short database claim protocol.
   Do not hold a database transaction across Google network calls. One caller
   claims provisioning; losers wait/re-read. A loser may delete only the root it
   created and recorded under its own attempt.
   **Verify**: `bun run typecheck` exits 0.
3. Claim and consume public single-use tokens before external uploads inside a
   short transaction, recording an attempt ID. Upload into an attempt-unique
   folder. On failure, mark the attempt failed and delete only ledger objects
   created by that attempt. Never delete a find-or-create result without a
   matching ownership row.
   **Verify**: `rg -n "deleteFile\(nextSubmissionFolderId\)" src` has no matches.
4. Preserve successful document versions: mark replaced objects superseded and
   keep them in Drive. Domain tables may point to the current version, but old
   provider objects must remain ledger-owned and auditable.
   **Verify**: review every `deleteFile(previous|old|existing)` match; only
   failed-attempt cleanup may remain.
5. Include Drive `size` in metadata reads/moves, or preserve the stored size
   when moving. Centralize bounded signature validation for supported PDF,
   image, DOC/DOCX container formats; reject empty, mismatched, and truncated
   uploads before Drive calls.
   **Verify**: `bun run typecheck` exits 0 and `git diff --check` exits 0.
6. Update API/storage documentation with the ownership and retention rules.

## Done criteria

- No error path deletes a folder/file without attempt ownership evidence.
- Successful previous documents are retained as superseded versions.
- Moved documents retain their real size.
- Root provisioning is serialized without a long DB transaction.
- Upload validation checks actual bounded content signatures.
- `bun run typecheck`, `bunx drizzle-kit check`, and `git diff --check` pass.

## STOP conditions

- Stop if migrations 0042/0043 are missing or migration numbering has advanced.
- Stop if cleanup would require deleting an object not created by the current attempt.
- Stop if Google Drive cannot return stable object IDs or parent metadata.
- Stop rather than adding tests; tests are intentionally deferred.

## Maintenance notes

All future storage providers must implement the same ownership/attempt contract.
Reviewers should scrutinize every deletion and every network call near a DB lock.

