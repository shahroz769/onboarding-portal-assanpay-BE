-- PlanetScale schema recommendation #9: unused index on
-- case_links.source_queue_id.
DROP INDEX IF EXISTS "case_links_source_queue_idx";
