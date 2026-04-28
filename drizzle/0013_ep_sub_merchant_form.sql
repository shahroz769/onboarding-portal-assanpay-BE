DO $$ BEGIN
  CREATE TYPE "sub_merchant_form_email_status" AS ENUM (
    'not_sent',
    'sent',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "case_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "case_id" uuid NOT NULL,
  "file_kind" varchar(80) NOT NULL,
  "original_name" varchar(255) NOT NULL,
  "mime_type" varchar(128) NOT NULL,
  "size_bytes" integer NOT NULL,
  "google_drive_file_id" varchar(255) NOT NULL,
  "google_drive_web_view_link" text NOT NULL,
  "google_drive_download_link" text,
  "google_drive_folder_id" varchar(255) NOT NULL,
  "uploaded_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "case_files_case_kind_uniq" UNIQUE ("case_id", "file_kind")
);

DO $$ BEGIN
  ALTER TABLE "case_files"
    ADD CONSTRAINT "case_files_case_id_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "case_files"
    ADD CONSTRAINT "case_files_uploaded_by_users_id_fk"
    FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "case_files_case_id_idx" ON "case_files" ("case_id");
CREATE INDEX IF NOT EXISTS "case_files_uploaded_by_idx" ON "case_files" ("uploaded_by");

CREATE TABLE IF NOT EXISTS "sub_merchant_form_details" (
  "case_id" uuid PRIMARY KEY NOT NULL,
  "sub_merchant_key" varchar(80) NOT NULL,
  "sub_merchant_name" varchar(160) NOT NULL,
  "draft_url" text NOT NULL,
  "final_form_file_id" uuid,
  "email_status" "sub_merchant_form_email_status" DEFAULT 'not_sent' NOT NULL,
  "email_log_id" uuid,
  "email_sent_at" timestamp with time zone,
  "email_recipient" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "sub_merchant_form_details"
    ADD CONSTRAINT "sub_merchant_form_details_case_id_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "sub_merchant_form_details"
    ADD CONSTRAINT "sub_merchant_form_details_final_form_file_id_case_files_id_fk"
    FOREIGN KEY ("final_form_file_id") REFERENCES "case_files"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "sub_merchant_form_details"
    ADD CONSTRAINT "sub_merchant_form_details_email_log_id_email_log_id_fk"
    FOREIGN KEY ("email_log_id") REFERENCES "email_log"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "sub_merchant_form_details_final_form_idx"
  ON "sub_merchant_form_details" ("final_form_file_id");
CREATE INDEX IF NOT EXISTS "sub_merchant_form_details_email_log_idx"
  ON "sub_merchant_form_details" ("email_log_id");

INSERT INTO queues (id, name, slug, prefix, qc_enabled, created_at)
VALUES (gen_random_uuid(), 'EP Sub-Merchant Form', 'sub-merchant-form', 'SM', false, now())
ON CONFLICT (slug) DO UPDATE
SET name = 'EP Sub-Merchant Form',
    prefix = 'SM',
    qc_enabled = false;

INSERT INTO queue_case_sequences (queue_id, last_number)
SELECT id, 0 FROM queues
WHERE slug = 'sub-merchant-form'
ON CONFLICT (queue_id) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT (queue_id, slug) DO NOTHING;

UPDATE queue_stages qs
SET name = CASE qs.slug
    WHEN 'new' THEN 'New'
    WHEN 'working' THEN 'Working'
    WHEN 'closed' THEN 'Closed'
    ELSE qs.name
  END,
  "order" = CASE qs.slug
    WHEN 'new' THEN 1
    WHEN 'working' THEN 2
    WHEN 'closed' THEN 3
    ELSE qs."order"
  END,
  category = CASE qs.slug
    WHEN 'new' THEN 'new'::stage_category
    WHEN 'working' THEN 'in_progress'::stage_category
    WHEN 'closed' THEN 'closed'::stage_category
    ELSE qs.category
  END
FROM queues q
WHERE q.id = qs.queue_id
  AND q.slug = 'sub-merchant-form'
  AND qs.slug IN ('new', 'working', 'closed');
