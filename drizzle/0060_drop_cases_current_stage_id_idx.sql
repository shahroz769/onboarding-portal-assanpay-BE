-- PlanetScale schema recommendation #1: cases_current_stage_id_idx is a
-- left-prefix duplicate of cases_current_stage_queue_idx.
DROP INDEX IF EXISTS "cases_current_stage_id_idx";
