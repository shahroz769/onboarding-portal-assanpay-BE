-- PlanetScale schema recommendation #5: queue_stages_queue_id_idx is a
-- left-prefix duplicate of queue_stages_queue_slug_uniq.
DROP INDEX IF EXISTS "queue_stages_queue_id_idx";
