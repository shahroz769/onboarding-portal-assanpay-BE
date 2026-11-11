-- Rejects case state changes that no application path is allowed to make,
-- whoever writes them (app code, scripts, hand-written SQL). Raises SQLSTATE
-- P7601, which the API maps to 409.
--
-- Checked only on UPDATE, and only when a state column changes: inserts and
-- unrelated updates (priority, flow version) never run it, so older rows that
-- predate these rules stay editable.
--
-- Rules:
--   reopen_closed_case        closed -> any other status
--   new_to_awaiting_merchant  new -> awaiting_merchant
--   awaiting_merchant_to_new  awaiting_merchant -> new
--   close_fields              closed needs closed_at and close_outcome; an open
--                             case has neither
--   working_without_owner     a case becomes working, or loses its owner while
--                             working, with no owner
--   stage_status_mismatch     status does not match the current stage category
--                             (new/new, working+awaiting_merchant/in_progress,
--                             closed/closed); a case with no stage is allowed
CREATE OR REPLACE FUNCTION "enforce_case_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  stage_category "stage_category";
BEGIN
  IF OLD."status" = 'closed' AND NEW."status" <> 'closed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P7601', MESSAGE = 'case_state_violation: reopen_closed_case';
  END IF;

  IF OLD."status" = 'new' AND NEW."status" = 'awaiting_merchant' THEN
    RAISE EXCEPTION USING ERRCODE = 'P7601', MESSAGE = 'case_state_violation: new_to_awaiting_merchant';
  END IF;

  IF OLD."status" = 'awaiting_merchant' AND NEW."status" = 'new' THEN
    RAISE EXCEPTION USING ERRCODE = 'P7601', MESSAGE = 'case_state_violation: awaiting_merchant_to_new';
  END IF;

  IF (
    OLD."status" IS DISTINCT FROM NEW."status"
    OR OLD."closed_at" IS DISTINCT FROM NEW."closed_at"
    OR OLD."close_outcome" IS DISTINCT FROM NEW."close_outcome"
  ) AND NOT (
    (NEW."status" = 'closed' AND NEW."closed_at" IS NOT NULL AND NEW."close_outcome" IS NOT NULL)
    OR (NEW."status" <> 'closed' AND NEW."closed_at" IS NULL AND NEW."close_outcome" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P7601', MESSAGE = 'case_state_violation: close_fields';
  END IF;

  IF NEW."status" = 'working'
    AND NEW."owner_id" IS NULL
    AND (OLD."status" IS DISTINCT FROM 'working' OR OLD."owner_id" IS NOT NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P7601', MESSAGE = 'case_state_violation: working_without_owner';
  END IF;

  IF NEW."current_stage_id" IS NOT NULL AND (
    OLD."status" IS DISTINCT FROM NEW."status"
    OR OLD."current_stage_id" IS DISTINCT FROM NEW."current_stage_id"
  ) THEN
    SELECT stage."category" INTO stage_category
    FROM "queue_stages" stage
    WHERE stage."id" = NEW."current_stage_id";

    IF stage_category IS NOT NULL AND NOT (
      (NEW."status" = 'new' AND stage_category = 'new')
      OR (NEW."status" IN ('working', 'awaiting_merchant') AND stage_category = 'in_progress')
      OR (NEW."status" = 'closed' AND stage_category = 'closed')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P7601', MESSAGE = 'case_state_violation: stage_status_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "cases_enforce_state" ON "cases";--> statement-breakpoint
CREATE TRIGGER "cases_enforce_state"
BEFORE UPDATE OF "status", "current_stage_id", "owner_id", "closed_at", "close_outcome" ON "cases"
FOR EACH ROW
WHEN (
  OLD."status" IS DISTINCT FROM NEW."status"
  OR OLD."current_stage_id" IS DISTINCT FROM NEW."current_stage_id"
  OR OLD."owner_id" IS DISTINCT FROM NEW."owner_id"
  OR OLD."closed_at" IS DISTINCT FROM NEW."closed_at"
  OR OLD."close_outcome" IS DISTINCT FROM NEW."close_outcome"
)
EXECUTE FUNCTION "enforce_case_state"();
