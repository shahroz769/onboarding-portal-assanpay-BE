CREATE INDEX IF NOT EXISTS "cases_current_stage_queue_idx"
  ON "cases" USING btree ("current_stage_id", "queue_id");
