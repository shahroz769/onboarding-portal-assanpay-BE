-- Fail loudly if any case points at a stage outside its queue (or a missing stage).
-- Do not rewrite rows; repair data before re-running this migration.
DO $$
DECLARE
  mismatch_ids text;
BEGIN
  SELECT string_agg(c.id::text, ', ' ORDER BY c.id)
  INTO mismatch_ids
  FROM cases c
  LEFT JOIN queue_stages qs ON qs.id = c.current_stage_id
  WHERE c.current_stage_id IS NOT NULL
    AND (qs.id IS NULL OR qs.queue_id IS DISTINCT FROM c.queue_id);

  IF mismatch_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot add cases(current_stage_id, queue_id) FK: stage/queue mismatches for case IDs: %',
      mismatch_ids;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "queue_stages"
  ADD CONSTRAINT "queue_stages_id_queue_id_uniq" UNIQUE ("id", "queue_id");
--> statement-breakpoint

ALTER TABLE "cases"
  DROP CONSTRAINT "cases_current_stage_id_queue_stages_id_fk";
--> statement-breakpoint

ALTER TABLE "cases"
  ADD CONSTRAINT "cases_current_stage_id_queue_id_fk"
  FOREIGN KEY ("current_stage_id", "queue_id")
  REFERENCES "queue_stages" ("id", "queue_id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;
