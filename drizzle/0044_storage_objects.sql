DO $$ BEGIN
  CREATE TYPE "storage_object_kind" AS ENUM ('file', 'folder');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "storage_object_visibility" AS ENUM ('private', 'public');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "storage_object_lifecycle" AS ENUM (
    'provisioning',
    'current',
    'superseded',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" varchar(40) DEFAULT 'google_drive' NOT NULL,
  "provider_object_id" varchar(255) NOT NULL,
  "object_kind" "storage_object_kind" NOT NULL,
  "merchant_id" uuid,
  "case_id" uuid,
  "visibility" "storage_object_visibility" NOT NULL,
  "attempt_id" uuid NOT NULL,
  "lifecycle" "storage_object_lifecycle" DEFAULT 'provisioning' NOT NULL,
  "parent_provider_object_id" varchar(255),
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "storage_objects"
    ADD CONSTRAINT "storage_objects_merchant_id_merchants_id_fk"
    FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "storage_objects"
    ADD CONSTRAINT "storage_objects_case_id_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_objects_provider_object_uniq"
  ON "storage_objects" ("provider", "provider_object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_objects_attempt_idx"
  ON "storage_objects" ("attempt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_objects_merchant_attempt_idx"
  ON "storage_objects" ("merchant_id", "attempt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_objects_case_attempt_idx"
  ON "storage_objects" ("case_id", "attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_objects_merchant_root_claim_uniq"
  ON "storage_objects" ("merchant_id", "visibility")
  WHERE ("metadata"->>'role') = 'merchant_root'
    AND "lifecycle" IN ('provisioning', 'current');
