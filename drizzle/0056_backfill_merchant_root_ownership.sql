INSERT INTO "storage_objects" (
  "provider",
  "provider_object_id",
  "object_kind",
  "merchant_id",
  "visibility",
  "attempt_id",
  "lifecycle",
  "metadata"
)
SELECT
  'google_drive',
  "google_drive_private_folder_id",
  'folder',
  "id",
  'private',
  gen_random_uuid(),
  'current',
  jsonb_build_object('role', 'merchant_root', 'source', 'ownership_backfill')
FROM "merchants"
WHERE "google_drive_private_folder_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "storage_objects" (
  "provider",
  "provider_object_id",
  "object_kind",
  "merchant_id",
  "visibility",
  "attempt_id",
  "lifecycle",
  "metadata"
)
SELECT
  'google_drive',
  "google_drive_public_folder_id",
  'folder',
  "id",
  'public',
  gen_random_uuid(),
  'current',
  jsonb_build_object('role', 'merchant_root', 'source', 'ownership_backfill')
FROM "merchants"
WHERE "google_drive_public_folder_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "storage_objects" (
  "provider",
  "provider_object_id",
  "object_kind",
  "merchant_id",
  "visibility",
  "attempt_id",
  "lifecycle",
  "parent_provider_object_id",
  "metadata"
)
SELECT
  'google_drive',
  "google_drive_file_id",
  'file',
  "merchant_id",
  'private',
  gen_random_uuid(),
  'current',
  "google_drive_folder_id",
  jsonb_build_object('role', 'merchant_document', 'source', 'ownership_backfill')
FROM "merchant_documents"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "storage_objects" (
  "provider",
  "provider_object_id",
  "object_kind",
  "merchant_id",
  "case_id",
  "visibility",
  "attempt_id",
  "lifecycle",
  "parent_provider_object_id",
  "metadata"
)
SELECT
  'google_drive',
  "case_files"."google_drive_file_id",
  'file',
  "cases"."merchant_id",
  "case_files"."case_id",
  'private',
  gen_random_uuid(),
  'current',
  "case_files"."google_drive_folder_id",
  jsonb_build_object('role', 'case_file', 'source', 'ownership_backfill')
FROM "case_files"
INNER JOIN "cases" ON "cases"."id" = "case_files"."case_id"
ON CONFLICT DO NOTHING;
