-- Records why a resubmission link stopped working, so an old or invalidated
-- link is not reported to the merchant as "already used". Links consumed
-- before this migration keep a null reason.
DO $$ BEGIN
  CREATE TYPE "resubmission_token_consumed_reason" AS ENUM ('used', 'superseded', 'invalidated');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "case_resubmission_tokens"
  ADD COLUMN IF NOT EXISTS "consumed_reason" "resubmission_token_consumed_reason";--> statement-breakpoint
ALTER TABLE "case_resubmission_tokens"
  DROP CONSTRAINT IF EXISTS "case_resubmission_tokens_reason_needs_consumed";--> statement-breakpoint
ALTER TABLE "case_resubmission_tokens"
  ADD CONSTRAINT "case_resubmission_tokens_reason_needs_consumed"
  CHECK ("consumed_reason" IS NULL OR "consumed_at" IS NOT NULL);--> statement-breakpoint
-- A link is consumed once and never reactivated. Raises SQLSTATE P7603, which
-- the API maps to 409.
--   reactivate        consumed_at or consumed_reason changed once set
--   missing_reason    a link consumed without a reason
CREATE OR REPLACE FUNCTION "enforce_resubmission_token_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."consumed_at" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'token_state_violation: reactivate';
  END IF;

  IF NEW."consumed_at" IS NOT NULL AND NEW."consumed_reason" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'token_state_violation: missing_reason';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "case_resubmission_tokens_enforce_state" ON "case_resubmission_tokens";--> statement-breakpoint
CREATE TRIGGER "case_resubmission_tokens_enforce_state"
BEFORE UPDATE OF "consumed_at", "consumed_reason" ON "case_resubmission_tokens"
FOR EACH ROW
WHEN (
  OLD."consumed_at" IS DISTINCT FROM NEW."consumed_at"
  OR OLD."consumed_reason" IS DISTINCT FROM NEW."consumed_reason"
)
EXECUTE FUNCTION "enforce_resubmission_token_state"();
