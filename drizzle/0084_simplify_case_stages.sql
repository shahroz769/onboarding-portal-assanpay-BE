-- Cases now only move through New, Working, Awaiting Merchant, and Closed.
-- Drop the queues.qc_enabled flag, the 'qc', 'pending', and 'error' values from
-- case_status, and the 'qc' and 'error' values from stage_category, and rename
-- 'awaiting_client' to 'awaiting_merchant'. Existing queue stages keep their
-- name, order, and category; only the awaiting stage slug is renamed to match.
-- Postgres cannot remove an enum value in place, so both types are recreated.
DO $$
DECLARE
  qc_queue_count integer;
  removed_stage_count integer;
  removed_case_count integer;
BEGIN
  SELECT count(*) INTO qc_queue_count FROM "queues" WHERE "qc_enabled";
  SELECT count(*) INTO removed_stage_count
  FROM "queue_stages"
  WHERE "category" IN ('qc', 'error');
  SELECT count(*) INTO removed_case_count
  FROM "cases"
  WHERE "status" IN ('qc', 'pending', 'error');

  IF qc_queue_count > 0 OR removed_stage_count > 0 OR removed_case_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0084 aborted: % queue(s) with QC enabled, % qc/error stage(s), % qc/pending/error case(s)',
      qc_queue_count, removed_stage_count, removed_case_count;
  END IF;
END $$;
--> statement-breakpoint

-- Same definition as 0075, without qc_enabled, so the column can be dropped.
CREATE OR REPLACE FUNCTION protect_case_flow_queue_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE queue uuid; changed boolean;
BEGIN
  IF TG_TABLE_NAME = 'queues' THEN
    queue := OLD.id;
    changed := TG_OP = 'DELETE';
    IF TG_OP = 'UPDATE' THEN
      changed := ROW(OLD.lifecycle, OLD.is_active, OLD.workflow_type, OLD.slug)
        IS DISTINCT FROM ROW(NEW.lifecycle, NEW.is_active, NEW.workflow_type, NEW.slug);
    END IF;
  ELSE
    queue := CASE WHEN TG_OP = 'INSERT' THEN NEW.queue_id ELSE OLD.queue_id END;
    changed := true;
    IF TG_OP = 'UPDATE' THEN
      changed := ROW(OLD.queue_id, OLD.slug, OLD."order", OLD.category, OLD.is_active, OLD.capabilities)
        IS DISTINCT FROM ROW(NEW.queue_id, NEW.slug, NEW."order", NEW.category, NEW.is_active, NEW.capabilities);
    END IF;
  END IF;
  IF changed AND queue_is_needed_by_case_flow(queue) THEN
    RAISE EXCEPTION USING ERRCODE = 'P7501', MESSAGE = 'Queue definition is required by a published flow';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

ALTER TABLE "queues" DROP COLUMN "qc_enabled";
--> statement-breakpoint

-- Partial index predicates hold case_status literals and would block the
-- column type change; recreate them afterwards.
DROP INDEX "cases_open_merchant_idx";
--> statement-breakpoint
DROP INDEX "cases_successful_flow_idx";
--> statement-breakpoint

ALTER TYPE "case_status" RENAME TO "case_status_old";
--> statement-breakpoint
CREATE TYPE "case_status" AS ENUM (
  'new',
  'working',
  'closed',
  'awaiting_merchant'
);
--> statement-breakpoint
ALTER TABLE "cases" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "cases"
  ALTER COLUMN "status" TYPE "case_status"
  USING (
    CASE "status"::text
      WHEN 'awaiting_client' THEN 'awaiting_merchant'
      ELSE "status"::text
    END
  )::"case_status";
--> statement-breakpoint
ALTER TABLE "cases" ALTER COLUMN "status" SET DEFAULT 'new';
--> statement-breakpoint
DROP TYPE "case_status_old";
--> statement-breakpoint

CREATE INDEX "cases_open_merchant_idx" ON "cases" USING btree ("merchant_id", "queue_id")
  WHERE "status" <> 'closed';
--> statement-breakpoint
CREATE INDEX "cases_successful_flow_idx" ON "cases" USING btree ("merchant_id", "queue_id")
  WHERE "status" = 'closed' AND "close_outcome" = 'successful';
--> statement-breakpoint

ALTER TYPE "stage_category" RENAME TO "stage_category_old";
--> statement-breakpoint
CREATE TYPE "stage_category" AS ENUM (
  'new',
  'in_progress',
  'closed'
);
--> statement-breakpoint
ALTER TABLE "queue_stages"
  ALTER COLUMN "category" TYPE "stage_category"
  USING "category"::text::"stage_category";
--> statement-breakpoint
DROP TYPE "stage_category_old";
--> statement-breakpoint

-- Rename the awaiting stage slug to match the status. The stage keeps its name,
-- order, and category, so the published-flow guard is bypassed for this update
-- only.
ALTER TABLE "queue_stages" DISABLE TRIGGER "queue_stages_protect_case_flow";
--> statement-breakpoint
UPDATE "queue_stages"
SET "slug" = 'awaiting_merchant'
WHERE "slug" = 'awaiting_client';
--> statement-breakpoint
ALTER TABLE "queue_stages" ENABLE TRIGGER "queue_stages_protect_case_flow";
--> statement-breakpoint

-- Keep recorded status values in case history consistent with the rename.
UPDATE "case_history"
SET "details" = replace(
  "details"::text,
  '"awaiting_client"',
  '"awaiting_merchant"'
)::jsonb
WHERE "details"::text LIKE '%"awaiting_client"%';
