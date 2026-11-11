-- Auth token lifecycles, enforced for every writer. Raises SQLSTATE P7603,
-- which the API maps to 409. App writers: modules/auth/refresh-token-state.ts
-- and modules/auth/password-token-state.ts.
--
-- Refresh tokens:
--   active  ──rotate──▶ rotated   (replaced by the next token in the chain)
--   active, rotated ──revoke──▶ revoked
--   revoked is final; revoked_at, once set, keeps the first time it was set.
--
-- Password links (invite / reset) are consumed once, for a reason:
--   used         the user set their password with it
--   superseded   a newer link of the same purpose was sent
--   invalidated  the password was set with another link
-- Links consumed before this migration keep a null reason.

-- Rows the earlier writers could leave without a revoked_at, before the check.
UPDATE "refresh_tokens" SET "revoked_at" = now()
WHERE "status" <> 'active' AND "revoked_at" IS NULL;--> statement-breakpoint
UPDATE "refresh_tokens" SET "revoked_at" = NULL
WHERE "status" = 'active' AND "revoked_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_revoked_at_matches_status";--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_revoked_at_matches_status"
  CHECK (("status" = 'active') = ("revoked_at" IS NULL));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_refresh_token_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'revoked' THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'refresh_token_state_violation: revoked_final';
  END IF;

  IF NEW."status" = 'active' AND OLD."status" <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'refresh_token_state_violation: reactivate';
  END IF;

  IF NEW."status" = 'rotated' AND OLD."status" <> 'rotated' AND (
    OLD."status" <> 'active' OR NEW."replaced_by_token_id" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'refresh_token_state_violation: rotate';
  END IF;

  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'refresh_token_state_violation: revoked_at_changed';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "refresh_tokens_enforce_state" ON "refresh_tokens";--> statement-breakpoint
CREATE TRIGGER "refresh_tokens_enforce_state"
BEFORE UPDATE OF "status", "revoked_at" ON "refresh_tokens"
FOR EACH ROW
WHEN (
  OLD."status" IS DISTINCT FROM NEW."status"
  OR OLD."revoked_at" IS DISTINCT FROM NEW."revoked_at"
)
EXECUTE FUNCTION "enforce_refresh_token_state"();--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "password_token_consumed_reason" AS ENUM ('used', 'superseded', 'invalidated');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "user_password_tokens"
  ADD COLUMN IF NOT EXISTS "consumed_reason" "password_token_consumed_reason";--> statement-breakpoint
ALTER TABLE "user_password_tokens"
  DROP CONSTRAINT IF EXISTS "user_password_tokens_reason_needs_consumed";--> statement-breakpoint
ALTER TABLE "user_password_tokens"
  ADD CONSTRAINT "user_password_tokens_reason_needs_consumed"
  CHECK ("consumed_reason" IS NULL OR "consumed_at" IS NOT NULL);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_password_token_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."consumed_at" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'password_token_state_violation: reactivate';
  END IF;

  IF NEW."consumed_at" IS NOT NULL AND NEW."consumed_reason" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'password_token_state_violation: missing_reason';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "user_password_tokens_enforce_state" ON "user_password_tokens";--> statement-breakpoint
CREATE TRIGGER "user_password_tokens_enforce_state"
BEFORE UPDATE OF "consumed_at", "consumed_reason" ON "user_password_tokens"
FOR EACH ROW
WHEN (
  OLD."consumed_at" IS DISTINCT FROM NEW."consumed_at"
  OR OLD."consumed_reason" IS DISTINCT FROM NEW."consumed_reason"
)
EXECUTE FUNCTION "enforce_password_token_state"();
