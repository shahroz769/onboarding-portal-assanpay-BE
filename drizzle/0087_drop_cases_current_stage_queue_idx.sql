-- PlanetScale schema recommendation #11: unused index on
-- cases(current_stage_id, queue_id). No query filters on current_stage_id,
-- and the app never deletes queue_stages rows, so the composite stage FK does
-- not need it. Dropping it removes write cost from every stage transition.
DROP INDEX IF EXISTS "cases_current_stage_queue_idx";
