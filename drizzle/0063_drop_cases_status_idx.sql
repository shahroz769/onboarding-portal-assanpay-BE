-- PlanetScale schema recommendation #4: cases_status_idx is a
-- left-prefix duplicate of cases_status_created_idx.
DROP INDEX IF EXISTS "cases_status_idx";
