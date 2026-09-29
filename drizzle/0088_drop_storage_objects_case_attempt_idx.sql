-- PlanetScale schema recommendation #16: unused index on
-- storage_objects(case_id, attempt_id). Ownership lookups go through
-- storage_objects_attempt_idx; nothing filters on case_id.
DROP INDEX IF EXISTS "storage_objects_case_attempt_idx";
