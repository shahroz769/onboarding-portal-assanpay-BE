ALTER TABLE "document_review_details"
  DROP CONSTRAINT "document_review_details_pkey";
--> statement-breakpoint
ALTER TABLE "document_review_details"
  ADD CONSTRAINT "document_review_details_pkey"
  PRIMARY KEY ("case_id", "sub_merchant_id");
--> statement-breakpoint
ALTER TABLE "cases"
  ADD COLUMN "sub_merchant_id" uuid;
--> statement-breakpoint
ALTER TABLE "cases"
  ADD CONSTRAINT "cases_sub_merchant_id_sub_merchant_draft_templates_id_fk"
  FOREIGN KEY ("sub_merchant_id")
  REFERENCES "public"."sub_merchant_draft_templates"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cases_sub_merchant_id_idx"
  ON "cases" USING btree ("sub_merchant_id");
--> statement-breakpoint
UPDATE "cases" AS target
SET "sub_merchant_id" = details."sub_merchant_key"::uuid
FROM "sub_merchant_form_details" AS details
WHERE details."case_id" = target."id"
  AND details."sub_merchant_key" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND target."sub_merchant_id" IS NULL;
--> statement-breakpoint
UPDATE "cases" AS target
SET "sub_merchant_id" = (
  SELECT review."sub_merchant_id"
  FROM "document_review_details" AS review
  INNER JOIN "cases" AS review_case ON review_case."id" = review."case_id"
  INNER JOIN "queues" AS review_queue ON review_queue."id" = review_case."queue_id"
  WHERE review_case."merchant_id" = target."merchant_id"
    AND review_queue."workflow_type" = 'document_review'
  ORDER BY review."updated_at" DESC
  LIMIT 1
)
FROM "queues" AS target_queue
WHERE target_queue."id" = target."queue_id"
  AND target_queue."workflow_type" = 'sub_merchant_form'
  AND target."sub_merchant_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "document_review_details" AS review
    INNER JOIN "cases" AS review_case ON review_case."id" = review."case_id"
    INNER JOIN "queues" AS review_queue ON review_queue."id" = review_case."queue_id"
    WHERE review_case."merchant_id" = target."merchant_id"
      AND review_queue."workflow_type" = 'document_review'
  );
