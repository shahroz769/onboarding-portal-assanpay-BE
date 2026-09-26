-- The DialogPay Card workflow is gone (its queue was deleted in 0051). Drop the
-- unused 'card' value from queue_workflow_type. Postgres cannot remove an enum
-- value in place, so the type is recreated without it.
DO $$
DECLARE
  card_queue_count integer;
BEGIN
  SELECT count(*)
  INTO card_queue_count
  FROM "queues"
  WHERE "workflow_type" = 'card';

  IF card_queue_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0081 aborted: % queue(s) still use the card workflow type',
      card_queue_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TYPE "queue_workflow_type" RENAME TO "queue_workflow_type_old";
--> statement-breakpoint
CREATE TYPE "queue_workflow_type" AS ENUM (
  'generic',
  'document_review',
  'agreement',
  'mid',
  'testing',
  'wordpress',
  'physical_agreement',
  'live',
  'sub_merchant_form'
);
--> statement-breakpoint
ALTER TABLE "queues" ALTER COLUMN "workflow_type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "queues"
  ALTER COLUMN "workflow_type" TYPE "queue_workflow_type"
  USING "workflow_type"::text::"queue_workflow_type";
--> statement-breakpoint
ALTER TABLE "queues" ALTER COLUMN "workflow_type" SET DEFAULT 'generic';
--> statement-breakpoint
DROP TYPE "queue_workflow_type_old";
