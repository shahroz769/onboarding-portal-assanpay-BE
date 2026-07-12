CREATE TYPE "queue_workflow_type" AS ENUM (
  'generic',
  'document_review',
  'agreement',
  'mid',
  'testing',
  'wordpress',
  'card',
  'physical_agreement',
  'live',
  'sub_merchant_form'
);
--> statement-breakpoint

CREATE TYPE "queue_lifecycle" AS ENUM (
  'draft',
  'active',
  'inactive'
);
--> statement-breakpoint

ALTER TABLE "queues"
  ADD COLUMN "workflow_type" "queue_workflow_type";
--> statement-breakpoint

ALTER TABLE "queues"
  ADD COLUMN "lifecycle" "queue_lifecycle" DEFAULT 'inactive' NOT NULL;
--> statement-breakpoint

ALTER TABLE "queues"
  ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint

ALTER TABLE "queues"
  ADD CONSTRAINT "queues_revision_positive" CHECK ("revision" >= 1);
--> statement-breakpoint

UPDATE "queues"
SET
  "lifecycle" = CASE
    WHEN "is_active" = true THEN 'active'::"queue_lifecycle"
    ELSE 'inactive'::"queue_lifecycle"
  END;
--> statement-breakpoint

UPDATE "queues"
SET "workflow_type" = CASE "slug"
  WHEN 'documents-review' THEN 'document_review'::"queue_workflow_type"
  WHEN 'agreement' THEN 'agreement'::"queue_workflow_type"
  WHEN 'merchant-id' THEN 'mid'::"queue_workflow_type"
  WHEN 'testing' THEN 'testing'::"queue_workflow_type"
  WHEN 'wordpress-website' THEN 'wordpress'::"queue_workflow_type"
  WHEN 'dialogpay-card' THEN 'card'::"queue_workflow_type"
  WHEN 'physical-agreement' THEN 'physical_agreement'::"queue_workflow_type"
  WHEN 'live' THEN 'live'::"queue_workflow_type"
  WHEN 'sub-merchant-form' THEN 'sub_merchant_form'::"queue_workflow_type"
  WHEN 'support-ticket' THEN 'generic'::"queue_workflow_type"
  ELSE NULL
END;
--> statement-breakpoint

DO $$
DECLARE
  unknown_slugs text;
BEGIN
  SELECT string_agg(q.slug, ', ' ORDER BY q.slug)
  INTO unknown_slugs
  FROM queues q
  WHERE q.workflow_type IS NULL;

  IF unknown_slugs IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0047 aborted: unknown queue slug(s) cannot be mapped to a workflow type: %',
      unknown_slugs;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "queues"
  ALTER COLUMN "workflow_type" SET DEFAULT 'generic';
--> statement-breakpoint

ALTER TABLE "queues"
  ALTER COLUMN "workflow_type" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "queue_stages"
  ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

ALTER TABLE "queue_stages"
  ADD COLUMN "capabilities" jsonb;
