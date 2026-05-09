ALTER TABLE "queues" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;

CREATE TABLE IF NOT EXISTS "configuration_settings" (
  "key" varchar(120) PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agreement_draft_templates" (
  "business_type" varchar(120) PRIMARY KEY NOT NULL,
  "label" varchar(160) NOT NULL,
  "original_name" varchar(255) NOT NULL,
  "mime_type" varchar(128) NOT NULL,
  "size_bytes" integer NOT NULL,
  "google_drive_file_id" varchar(255) NOT NULL,
  "google_drive_web_view_link" text NOT NULL,
  "google_drive_download_link" text,
  "google_drive_folder_id" varchar(255) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sub_merchant_draft_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(160) NOT NULL,
  "original_name" varchar(255) NOT NULL,
  "mime_type" varchar(128) NOT NULL,
  "size_bytes" integer NOT NULL,
  "google_drive_file_id" varchar(255) NOT NULL,
  "google_drive_web_view_link" text NOT NULL,
  "google_drive_download_link" text,
  "google_drive_folder_id" varchar(255) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sub_merchant_draft_templates_name_unique" UNIQUE("name")
);
