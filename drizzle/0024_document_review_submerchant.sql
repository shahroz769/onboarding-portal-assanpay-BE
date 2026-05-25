CREATE TABLE IF NOT EXISTS "document_review_details" (
  "case_id" uuid PRIMARY KEY NOT NULL,
  "sub_merchant_id" uuid NOT NULL,
  "sub_merchant_name" varchar(160) NOT NULL,
  "selected_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_review_details_case_id_cases_id_fk"
    FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "document_review_details_sub_merchant_id_sub_merchant_draft_templates_id_fk"
    FOREIGN KEY ("sub_merchant_id") REFERENCES "public"."sub_merchant_draft_templates"("id")
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "document_review_details_selected_by_users_id_fk"
    FOREIGN KEY ("selected_by") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_details_sub_merchant_idx"
  ON "document_review_details" USING btree ("sub_merchant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_review_details_selected_by_idx"
  ON "document_review_details" USING btree ("selected_by");
