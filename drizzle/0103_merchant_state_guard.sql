-- Rejects merchant state changes that no application path is allowed to make,
-- whoever writes them (app code, scripts, hand-written SQL). Raises SQLSTATE
-- P7602, which the API maps to 409.
--
-- Merchant rules, checked only on UPDATE and only when a state column
-- changes. Permanent delete removes the row and is not affected.
--   reopen_terminated            terminated -> any other status
--   live_without_testing         live from any status but testing
--   backward_move                live -> testing/pending, testing -> pending
--   delete_requires_terminated   deleted_at set on a merchant that is not
--                                terminated
--   undelete                     deleted_at cleared
--   drive_files_requires_terminated
--                                drive_files_deleted_at set on a merchant that
--                                is not terminated
--   drive_files_undelete         drive_files_deleted_at cleared
--
-- Case rule, checked on INSERT:
--   case_for_terminated_merchant a new case for a terminated or deleted
--                                merchant
CREATE OR REPLACE FUNCTION "enforce_merchant_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" THEN
    IF OLD."status" = 'terminated' THEN
      RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: reopen_terminated';
    END IF;

    IF NEW."status" = 'live' AND OLD."status" <> 'testing' THEN
      RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: live_without_testing';
    END IF;

    IF NEW."status" <> 'terminated' AND NOT (
      OLD."status" = 'pending' AND NEW."status" = 'testing'
      OR OLD."status" = 'testing' AND NEW."status" = 'live'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: backward_move';
    END IF;
  END IF;

  IF OLD."deleted_at" IS NOT NULL AND NEW."deleted_at" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: undelete';
  END IF;

  IF NEW."deleted_at" IS NOT NULL
    AND OLD."deleted_at" IS NULL
    AND NEW."status" <> 'terminated'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: delete_requires_terminated';
  END IF;

  IF OLD."drive_files_deleted_at" IS NOT NULL AND NEW."drive_files_deleted_at" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: drive_files_undelete';
  END IF;

  IF NEW."drive_files_deleted_at" IS NOT NULL
    AND OLD."drive_files_deleted_at" IS NULL
    AND NEW."status" <> 'terminated'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: drive_files_requires_terminated';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "merchants_enforce_state" ON "merchants";--> statement-breakpoint
CREATE TRIGGER "merchants_enforce_state"
BEFORE UPDATE OF "status", "deleted_at", "drive_files_deleted_at" ON "merchants"
FOR EACH ROW
WHEN (
  OLD."status" IS DISTINCT FROM NEW."status"
  OR OLD."deleted_at" IS DISTINCT FROM NEW."deleted_at"
  OR OLD."drive_files_deleted_at" IS DISTINCT FROM NEW."drive_files_deleted_at"
)
EXECUTE FUNCTION "enforce_merchant_state"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_case_merchant_open"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "merchants" merchant
    WHERE merchant."id" = NEW."merchant_id"
      AND (merchant."status" = 'terminated' OR merchant."deleted_at" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P7602', MESSAGE = 'merchant_state_violation: case_for_terminated_merchant';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "cases_require_open_merchant" ON "cases";--> statement-breakpoint
CREATE TRIGGER "cases_require_open_merchant"
BEFORE INSERT ON "cases"
FOR EACH ROW
EXECUTE FUNCTION "enforce_case_merchant_open"();
