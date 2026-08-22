-- PlanetScale schema recommendation #3: cases_queue_id_idx is a
-- left-prefix duplicate of cases_queue_created_idx.
DROP INDEX IF EXISTS "cases_queue_id_idx";
