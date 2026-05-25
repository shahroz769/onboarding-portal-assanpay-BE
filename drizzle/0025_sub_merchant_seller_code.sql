ALTER TABLE "sub_merchant_draft_templates"
  ADD COLUMN IF NOT EXISTS "seller_code" varchar(80);
--> statement-breakpoint
UPDATE "sub_merchant_draft_templates"
SET "seller_code" = 'MST-715012'
WHERE "seller_code" IS NULL;
--> statement-breakpoint
ALTER TABLE "sub_merchant_draft_templates"
  ALTER COLUMN "seller_code" SET NOT NULL;