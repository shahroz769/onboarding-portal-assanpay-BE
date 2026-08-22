-- PlanetScale schema recommendation #2: cases_owner_id_idx is a
-- left-prefix duplicate of cases_owner_created_idx.
DROP INDEX IF EXISTS "cases_owner_id_idx";
