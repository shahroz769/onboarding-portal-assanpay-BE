-- PlanetScale schema recommendation #7: unused index on
-- case_flow_close_triggers.target_queue_id.
DROP INDEX IF EXISTS "case_flow_close_triggers_target_idx";
