-- These legacy names duplicate the canonical query indexes declared in
-- src/db/schema.ts. Keep the canonical indexes and remove only stale copies.
DROP INDEX IF EXISTS "cases_created_at_id_idx";
DROP INDEX IF EXISTS "cases_owner_created_at_id_idx";
DROP INDEX IF EXISTS "cases_queue_created_at_id_idx";
DROP INDEX IF EXISTS "cases_status_created_at_id_idx";
