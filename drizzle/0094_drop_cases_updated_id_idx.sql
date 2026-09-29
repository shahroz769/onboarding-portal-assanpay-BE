-- PlanetScale schema recommendation #14: unused index on
-- cases(updated_at, id). The case list "Updated" sort is rare and sorts in
-- memory at current volume, while updated_at changes on every case write.
DROP INDEX IF EXISTS "cases_updated_id_idx";
