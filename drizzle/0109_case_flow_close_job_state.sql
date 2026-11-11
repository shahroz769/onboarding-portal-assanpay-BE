-- A close job's state was spread over completed_at, last_error, blocked_at
-- and failed_at, and only the health query said how to read them. This adds
-- the state as a generated column, so it can never disagree with them, and
-- rejects combinations no writer may produce. Writers go through
-- case-flow-job-state.ts.
--
--   pending    open, no error
--   retrying   open, last attempt failed with a transient error
--   failed     open, still failing after the degraded-after attempt count
--   blocked    open, waiting on a creation requirement
--   completed  final
--
-- Repair rows the earlier writers could leave inconsistent before the checks
-- go on. A direct backfill completed jobs without clearing blocked_at.
UPDATE "case_flow_close_jobs"
SET "last_error" = NULL, "blocked_at" = NULL, "failed_at" = NULL
WHERE "completed_at" IS NOT NULL
  AND ("last_error" IS NOT NULL OR "blocked_at" IS NOT NULL OR "failed_at" IS NOT NULL);--> statement-breakpoint
UPDATE "case_flow_close_jobs"
SET "failed_at" = NULL
WHERE "blocked_at" IS NOT NULL AND "failed_at" IS NOT NULL;--> statement-breakpoint
UPDATE "case_flow_close_jobs"
SET "blocked_at" = NULL, "failed_at" = NULL
WHERE "last_error" IS NULL AND ("blocked_at" IS NOT NULL OR "failed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "case_flow_close_jobs" ADD COLUMN IF NOT EXISTS "status" varchar(16)
  GENERATED ALWAYS AS (
    CASE
      WHEN "completed_at" IS NOT NULL THEN 'completed'
      WHEN "blocked_at" IS NOT NULL THEN 'blocked'
      WHEN "failed_at" IS NOT NULL THEN 'failed'
      WHEN "last_error" IS NOT NULL THEN 'retrying'
      ELSE 'pending'
    END
  ) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "case_flow_close_jobs" DROP CONSTRAINT IF EXISTS "case_flow_close_jobs_state_check";--> statement-breakpoint
-- blocked and failed are exclusive and both carry the error that caused them;
-- a completed job keeps none of the retry fields.
ALTER TABLE "case_flow_close_jobs" ADD CONSTRAINT "case_flow_close_jobs_state_check"
  CHECK (
    NOT ("blocked_at" IS NOT NULL AND "failed_at" IS NOT NULL)
    AND (("blocked_at" IS NULL AND "failed_at" IS NULL) OR "last_error" IS NOT NULL)
    AND ("completed_at" IS NULL
      OR ("last_error" IS NULL AND "blocked_at" IS NULL AND "failed_at" IS NULL))
  );--> statement-breakpoint
-- A completed job is the tombstone proving its target case was created, so it
-- never reopens. Raises SQLSTATE P7603, which the API maps to 409.
CREATE OR REPLACE FUNCTION "enforce_case_flow_close_job_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS DISTINCT FROM OLD."completed_at" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P7603',
      MESSAGE = 'case_flow_job_state_violation: reopen_completed_job';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "case_flow_close_jobs_enforce_state" ON "case_flow_close_jobs";--> statement-breakpoint
CREATE TRIGGER "case_flow_close_jobs_enforce_state"
BEFORE UPDATE OF "completed_at" ON "case_flow_close_jobs"
FOR EACH ROW
WHEN (OLD."completed_at" IS DISTINCT FROM NEW."completed_at")
EXECUTE FUNCTION "enforce_case_flow_close_job_state"();
