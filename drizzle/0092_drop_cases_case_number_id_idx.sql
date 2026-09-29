-- PlanetScale schema recommendation #20: cases(case_number, id) is redundant
-- with the unique index on case_number, which already orders the case list
-- sort by case number.
DROP INDEX IF EXISTS "cases_case_number_id_idx";
