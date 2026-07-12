# Storage ownership and cleanup

Google Drive objects created by this API are tracked in the `storage_objects`
ledger. Cleanup and retention are based on that ledger, never on folder names
or IDs returned by find-or-create alone.

## Attempt ownership

Every upload or provisioning flow that creates Drive objects must:

1. Allocate an `attemptId` via `createStorageAttemptId()`.
2. Record each created file or folder with `recordStorageObject` under that
   attempt (`lifecycle: provisioning`).
3. On success, mark those objects `current` with
   `markStorageObjectsLifecycle`.
4. On failure, call `cleanupFailedAttemptObjects({ attemptId, storage })`.

Public single-use tokens (resubmission / agreement upload) are consumed in a
short database transaction **before** any Drive upload so concurrent callers
cannot both upload and then race on cleanup.

## Retention

Successful previous versions are retained:

- When a domain row points at a newer Drive file, call
  `supersedeStorageObjects([previousProviderObjectId])`.
- Do **not** delete previous successful documents from Drive.
- Superseded objects remain ledger-owned and auditable.

## Failed-attempt-only cleanup

`cleanupFailedAttemptObjects` is the only allowed deletion path for attempt
work:

- It deletes only objects recorded for that attempt.
- It never deletes find-or-create parents that lack a matching ownership row.
- Pending merchant-root claim placeholders (`pending-root:*`) are skipped until
  finalized with a real provider ID.

Do not call `storage.deleteFile` from feature modules for previous versions or
shared folders.
