-- PlanetScale schema recommendation #13: unused index on
-- user_password_tokens.user_id. The table holds one row per staff invite or
-- reset, so the per-user token lookups are cheaper as a sequential scan.
DROP INDEX IF EXISTS "user_password_tokens_user_idx";
