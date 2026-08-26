ALTER TABLE "case_flow_close_jobs"
ADD COLUMN "only_if_target_missing" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "case_flow_close_jobs_pending_idx";
--> statement-breakpoint
CREATE INDEX "case_flow_close_jobs_pending_idx"
ON "case_flow_close_jobs" USING btree ("available_at", "created_at")
WHERE "completed_at" IS NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enqueue_case_flow_jobs_after_successful_close"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  should_enqueue boolean := false;
BEGIN
  IF NEW."status" = 'closed' AND NEW."close_outcome" = 'successful' THEN
    IF TG_OP = 'INSERT' THEN
      should_enqueue := true;
    ELSIF OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."close_outcome" IS DISTINCT FROM NEW."close_outcome"
    THEN
      should_enqueue := true;
    END IF;
  END IF;

  IF should_enqueue THEN
    INSERT INTO "case_flow_close_jobs" (
      "source_case_id",
      "merchant_id",
      "source_queue_id",
      "target_queue_id",
      "only_if_target_missing"
    )
    SELECT
      NEW."id",
      NEW."merchant_id",
      NEW."queue_id",
      close_trigger."target_queue_id",
      true
    FROM "case_flow_close_triggers" close_trigger
    WHERE close_trigger."source_queue_id" = NEW."queue_id"
      AND close_trigger."is_active" = true
      AND NOT EXISTS (
        SELECT 1
        FROM "case_flow_close_jobs" completed_job
        WHERE completed_job."merchant_id" = NEW."merchant_id"
          AND completed_job."target_queue_id" = close_trigger."target_queue_id"
          AND completed_job."completed_at" IS NOT NULL
      )
    ON CONFLICT ("source_case_id", "target_queue_id") DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "cases_enqueue_flow_jobs_after_successful_close" ON "cases";
--> statement-breakpoint
CREATE TRIGGER "cases_enqueue_flow_jobs_after_successful_close"
AFTER INSERT OR UPDATE ON "cases"
FOR EACH ROW
EXECUTE FUNCTION "enqueue_case_flow_jobs_after_successful_close"();
--> statement-breakpoint

-- Forward repair for migration 0057, which removed Physical Agreement jobs
-- and cascade-deleted rules without remapping them. Reconcile current active
-- close rules against successful historical closures without recreating a
-- target case that exists now or is proven to have existed by a completed job.
INSERT INTO "case_flow_close_jobs" (
  "source_case_id",
  "merchant_id",
  "source_queue_id",
  "target_queue_id",
  "only_if_target_missing"
)
SELECT DISTINCT ON (
  source_case."merchant_id",
  close_trigger."target_queue_id"
)
  source_case."id",
  source_case."merchant_id",
  source_case."queue_id",
  close_trigger."target_queue_id",
  true
FROM "cases" source_case
INNER JOIN "case_flow_close_triggers" close_trigger
  ON close_trigger."source_queue_id" = source_case."queue_id"
  AND close_trigger."is_active" = true
WHERE source_case."status" = 'closed'
  AND source_case."close_outcome" = 'successful'
  AND NOT EXISTS (
    SELECT 1
    FROM "cases" target_case
    WHERE target_case."merchant_id" = source_case."merchant_id"
      AND target_case."queue_id" = close_trigger."target_queue_id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "case_flow_close_jobs" completed_job
    WHERE completed_job."merchant_id" = source_case."merchant_id"
      AND completed_job."target_queue_id" = close_trigger."target_queue_id"
      AND completed_job."completed_at" IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "case_flow_close_jobs" unfinished_job
    WHERE unfinished_job."merchant_id" = source_case."merchant_id"
      AND unfinished_job."target_queue_id" = close_trigger."target_queue_id"
      AND unfinished_job."completed_at" IS NULL
  )
ORDER BY
  source_case."merchant_id",
  close_trigger."target_queue_id",
  source_case."closed_at" DESC NULLS LAST,
  source_case."created_at" DESC,
  source_case."id" DESC
ON CONFLICT ("source_case_id", "target_queue_id") DO NOTHING;
