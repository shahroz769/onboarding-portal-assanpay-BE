-- PlanetScale schema recommendation #18: unused index on
-- case_flow_close_jobs.target_queue_id. Job lookups filter by merchant first
-- (case_flow_close_jobs_merchant_idx).
DROP INDEX IF EXISTS "case_flow_close_jobs_target_queue_idx";
