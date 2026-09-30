-- Merchant search ORs business_name, submitter_email and owner_full_name.
-- The first two already have trigram indexes; without one on the third the
-- planner cannot combine them (BitmapOr) and scans the whole table. Plain
-- CREATE INDEX: the migrator runs in a transaction and merchants is small.
CREATE INDEX IF NOT EXISTS "merchants_owner_full_name_trgm_idx" ON "merchants" USING gin ("owner_full_name" gin_trgm_ops);
