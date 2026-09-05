# Case flow versioning

A successful merchant insert pins the currently published version in the same transaction as submission and initial case creation. Opening a form does not reserve a version. Merchant updates and document resubmissions retain their assignment. Cases and outbox jobs inherit the merchant version through database triggers; assignments cannot be changed.

Publishing validates and inserts all four rule sets under a new version, seals that version, then advances the current-version pointer atomically. Publication and merchant insertion lock the same singleton row, so a submission cannot see a mixture of old and new rules. Published rows cannot be edited or deleted. Existing jobs are not reset by publication. Backfill selects merchants belonging to the selected trigger version only. Version numbers may have gaps after rolled-back transactions.

GET /api/configuration/case-flow returns the current version and version history. GET /api/configuration/case-flow/versions/:versionId returns historical rules and their saved queue labels. PUT /api/configuration/case-flow publishes a new version and requires the current revision. It accepts an optional changeNote. These endpoints retain existing admin authorization. PublishedBy records the authenticated user.

## Deployment / cutover

1. Review historical assignments first. Migration 0075 snapshots CURRENT rules as v1 for all existing merchants, cases, and jobs. It cannot reconstruct previously overwritten flows. If older cohorts need distinct historical definitions, recover them from verified backups/audit evidence before proceeding with this baseline migration.
2. Back up the target database through the normal operator process. Pause configuration publishing, submissions, case mutations, and every worker/API instance; do not perform a rolling mixed-version deployment.
3. Apply the forward migration 0075_case_flow_versions.sql using the existing migration runner and journal against the explicitly selected deployment database. The migration takes exclusive locks while establishing the baseline. It was not run against the normal runtime database during implementation.
4. Deploy matching backend and frontend code before resuming traffic. Old code cannot publish into immutable tables, and new code requires the migrated schema.
5. Verify all merchants, cases, and jobs have a version; their assignments agree; v1 contains all baseline rules; the active pointer references a published version; and worker health is normal. Smoke-test an old merchant and a new submission after publication. Test simultaneous publication/submission with separate PostgreSQL connections in staging.
6. Resume workers and traffic. Keep v1 and all historical versions. Do not roll the backend back to unversioned code after cutover. To restore previous behavior for NEW submissions, publish a reviewed copy as a new version; this does not migrate existing merchants.

## Shared queue definitions

Queue retirement and changes to workflow type, QC settings, slug, or stage semantics are blocked while referenced by the current version or an unfinished flow (pending/testing merchants, open cases, or unfinished jobs). This includes queues a merchant has not reached yet. Use a new queue for incompatible changes. Presentation labels and operational settings such as SLA remain editable. Queue deletion also respects historical rule foreign keys. Historical graph labels come from the publication snapshot; this feature does not version document templates or arbitrary application business logic.

## Verification

Run `bun run typecheck` in both repositories. Before deployment, smoke-test old and new submissions, delayed jobs, version-specific backfill, immutable rules, and simultaneous publication/submission with separate PostgreSQL connections in staging. No frontend or backend build is required.
