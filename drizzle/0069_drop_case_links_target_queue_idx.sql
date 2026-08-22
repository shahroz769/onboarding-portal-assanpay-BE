-- PlanetScale schema recommendation #10: unused index on
-- case_links.target_queue_id.
DROP INDEX IF EXISTS "case_links_target_queue_idx";
