-- PlanetScale schema recommendation #12: unused index on
-- user_queue_access.queue_id.
DROP INDEX IF EXISTS "user_queue_access_queue_idx";
