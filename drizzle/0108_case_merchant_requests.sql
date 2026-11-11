-- A case reserved as awaiting_merchant while its email is sent (or its manual
-- proof uploaded). The row is written in the reservation's transaction and
-- resolved exactly once, so a crash or error between the reservation and its
-- outcome is recovered instead of leaving the case waiting for nothing.
DO $$ BEGIN
  CREATE TYPE "case_merchant_request_kind" AS ENUM (
    'document_resubmission',
    'agreement',
    'document_resubmission_manual',
    'agreement_manual'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_merchant_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "case_id" uuid NOT NULL REFERENCES "cases"("id") ON DELETE cascade,
  "kind" "case_merchant_request_kind" NOT NULL,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "email_log_id" uuid REFERENCES "email_log"("id") ON DELETE set null,
  "token_id" uuid,
  "release_stage_id" uuid,
  "details" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "outcome" varchar(20),
  CONSTRAINT "case_merchant_requests_outcome_check"
    CHECK (("resolved_at" IS NULL) = ("outcome" IS NULL)
      AND ("outcome" IS NULL OR "outcome" IN ('sent', 'failed')))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_merchant_requests_case_idx"
  ON "case_merchant_requests" ("case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_merchant_requests_email_log_idx"
  ON "case_merchant_requests" ("email_log_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_merchant_requests_pending_idx"
  ON "case_merchant_requests" ("created_at")
  WHERE "resolved_at" IS NULL;
