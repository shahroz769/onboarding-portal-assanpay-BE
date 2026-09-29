-- PlanetScale schema recommendation #17: unused index on
-- case_flow_close_jobs.source_queue_id.
DROP INDEX IF EXISTS "case_flow_close_jobs_source_queue_idx";
