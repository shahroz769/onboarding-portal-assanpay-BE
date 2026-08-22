CREATE INDEX IF NOT EXISTS "cases_merchant_created_idx"
  ON "cases" USING btree ("merchant_id", "created_at", "id");
