-- PlanetScale schema recommendation #6: unused index on
-- case_flow_close_blockers.prerequisite_queue_id.
DROP INDEX IF EXISTS "case_flow_close_blockers_prerequisite_idx";
