-- PlanetScale schema recommendation #8: unused index on
-- case_flow_creation_requirements.prerequisite_queue_id.
DROP INDEX IF EXISTS "case_flow_creation_requirements_prerequisite_idx";
