-- PlanetScale schema recommendation #19: unused index on
-- case_resubmission_tokens.case_id. Every case_id lookup also filters
-- consumed_at IS NULL and is served by
-- case_resubmission_tokens_one_active_per_case_idx.
DROP INDEX IF EXISTS "case_resubmission_tokens_case_id_idx";
