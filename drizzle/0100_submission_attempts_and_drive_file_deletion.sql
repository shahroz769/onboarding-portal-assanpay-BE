-- Every public onboarding attempt, accepted or not, so abuse can be traced to an
-- IP and limited per IP. merchant_id survives a permanent merchant delete as NULL
-- so the IP limit and the audit trail still hold.
DO $$ BEGIN
  CREATE TYPE "public"."public_submission_outcome" AS ENUM ('created', 'replayed', 'rate_limited', 'rejected', 'error');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public_submission_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ip_address" varchar(64) NOT NULL,
  "user_agent" varchar(512),
  "outcome" "public_submission_outcome" NOT NULL,
  "status_code" integer NOT NULL,
  "error_message" varchar(500),
  "merchant_id" uuid REFERENCES "merchants"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_submission_attempts_ip_created_idx" ON "public_submission_attempts" ("ip_address", "created_at") WHERE "outcome" = 'created';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_submission_attempts_created_idx" ON "public_submission_attempts" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_submission_attempts_merchant_idx" ON "public_submission_attempts" ("merchant_id");--> statement-breakpoint
-- Set once a terminated merchant's Drive files are gone. The merchant and its
-- document records stay, so the UI must stop offering links to those files.
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "drive_files_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "drive_files_deleted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_drive_files_deleted_by_idx" ON "merchants" ("drive_files_deleted_by");--> statement-breakpoint
ALTER TYPE "public"."storage_object_lifecycle" ADD VALUE IF NOT EXISTS 'deleted';
