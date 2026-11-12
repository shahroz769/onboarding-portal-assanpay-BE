-- A resubmission link is "pending" from the email preview until the owner
-- confirms sending it, and "delivered" once it reaches the merchant. Staff
-- changes revoke pending links only, so an internal reassignment never breaks
-- the link a merchant already has. A pending preview also no longer replaces
-- the delivered link: a case holds at most one active link of each kind.
ALTER TABLE "case_resubmission_tokens"
  ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;--> statement-breakpoint
-- Every link active before this migration went out by email, WhatsApp or a
-- regenerated link, or replaced one that had; treat them as delivered so no
-- merchant loses a working link. Not a consumed_at/consumed_reason update, so
-- the 0106 state trigger does not fire.
UPDATE "case_resubmission_tokens"
  SET "delivered_at" = "created_at"
  WHERE "consumed_at" IS NULL AND "delivered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_resubmission_tokens_one_active_per_case_kind_idx"
  ON "case_resubmission_tokens" ("case_id", ("delivered_at" IS NOT NULL))
  WHERE "consumed_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "case_resubmission_tokens_one_active_per_case_idx";
