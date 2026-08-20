DO $$
DECLARE
  physical_case_count integer;
BEGIN
  SELECT count(*)
  INTO physical_case_count
  FROM "cases" case_row
  INNER JOIN "queues" queue_row ON queue_row."id" = case_row."queue_id"
  WHERE queue_row."workflow_type" = 'physical_agreement';

  IF physical_case_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0057 aborted: Physical Agreement queue has % case(s)',
      physical_case_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "agreement_case_details"
  RENAME COLUMN "client_agreement_file_id" TO "received_agreement_file_id";
--> statement-breakpoint

ALTER TABLE "agreement_case_details"
  RENAME CONSTRAINT "agreement_case_details_client_agreement_file_id_case_files_id_fk"
  TO "agreement_case_details_received_agreement_file_id_case_files_id_fk";
--> statement-breakpoint

ALTER INDEX IF EXISTS "agreement_case_details_client_file_idx"
  RENAME TO "agreement_case_details_received_file_idx";
--> statement-breakpoint

DELETE FROM "case_flow_close_jobs"
WHERE "source_queue_id" IN (
  SELECT "id" FROM "queues" WHERE "workflow_type" = 'physical_agreement'
)
OR "target_queue_id" IN (
  SELECT "id" FROM "queues" WHERE "workflow_type" = 'physical_agreement'
);
--> statement-breakpoint

DELETE FROM "case_links"
WHERE "source_queue_id" IN (
  SELECT "id" FROM "queues" WHERE "workflow_type" = 'physical_agreement'
)
OR "target_queue_id" IN (
  SELECT "id" FROM "queues" WHERE "workflow_type" = 'physical_agreement'
);
--> statement-breakpoint

DELETE FROM "queues"
WHERE "workflow_type" = 'physical_agreement';
