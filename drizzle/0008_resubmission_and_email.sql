-- Add new case status value
DO $$ BEGIN
  ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'awaiting_client';
EXCEPTION WHEN others THEN null; END $$;

-- Add new notification type value
DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'case_resubmitted';
EXCEPTION WHEN others THEN null; END $$;

-- Email log status enum
DO $$ BEGIN
  CREATE TYPE "email_log_status" AS ENUM (
    'queued',
    'sent',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Add resubmitted_at to case_field_reviews
ALTER TABLE "case_field_reviews"
  ADD COLUMN IF NOT EXISTS "resubmitted_at" timestamp with time zone;

-- Resubmission tokens table
CREATE TABLE IF NOT EXISTS "case_resubmission_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "case_id" uuid NOT NULL,
  "token" varchar(86) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "case_resubmission_tokens_token_unique" UNIQUE ("token")
);

DO $$ BEGIN
  ALTER TABLE "case_resubmission_tokens"
    ADD CONSTRAINT "case_resubmission_tokens_case_id_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "case_resubmission_tokens"
    ADD CONSTRAINT "case_resubmission_tokens_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "case_resubmission_tokens_case_id_idx"
  ON "case_resubmission_tokens" ("case_id");

-- Email log table
CREATE TABLE IF NOT EXISTS "email_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "to_email" varchar(255) NOT NULL,
  "subject" varchar(500) NOT NULL,
  "template" varchar(120) NOT NULL,
  "case_id" uuid,
  "merchant_id" uuid,
  "resend_id" varchar(255),
  "status" "email_log_status" DEFAULT 'queued' NOT NULL,
  "error_msg" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "email_log"
    ADD CONSTRAINT "email_log_case_id_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "email_log"
    ADD CONSTRAINT "email_log_merchant_id_merchants_id_fk"
    FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "email_log_case_id_idx" ON "email_log" ("case_id");
CREATE INDEX IF NOT EXISTS "email_log_status_idx" ON "email_log" ("status");
CREATE INDEX IF NOT EXISTS "email_log_created_at_idx" ON "email_log" ("created_at");

-- Seed awaiting_client stage for documents-review queue (between working and closed)
DO $$
DECLARE
  v_queue_id uuid;
  v_existing uuid;
  v_target_order int;
BEGIN
  SELECT id INTO v_queue_id FROM queues WHERE slug = 'documents-review' LIMIT 1;

  IF v_queue_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO v_existing
    FROM queue_stages
    WHERE queue_id = v_queue_id AND slug = 'awaiting_client'
    LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN;
  END IF;

  -- Place after the highest in_progress stage
  SELECT COALESCE(MAX("order"), 0) + 1
    INTO v_target_order
    FROM queue_stages
    WHERE queue_id = v_queue_id AND category = 'in_progress';

  -- Shift later stages down by one
  UPDATE queue_stages
    SET "order" = "order" + 1
    WHERE queue_id = v_queue_id AND "order" >= v_target_order;

  INSERT INTO queue_stages (queue_id, name, slug, "order", category)
  VALUES (v_queue_id, 'Awaiting Client', 'awaiting_client', v_target_order, 'in_progress');
END $$;
