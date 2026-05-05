CREATE TYPE "public"."agreement_email_status" AS ENUM('not_sent', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "agreement_case_details" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"business_type" varchar(120) NOT NULL,
	"draft_key" varchar(80) NOT NULL,
	"draft_label" varchar(120) NOT NULL,
	"draft_url" text NOT NULL,
	"final_agreement_file_id" uuid,
	"client_agreement_file_id" uuid,
	"email_status" "agreement_email_status" DEFAULT 'not_sent' NOT NULL,
	"email_log_id" uuid,
	"email_sent_at" timestamp with time zone,
	"email_recipient" varchar(255),
	"last_rejection_remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_case_details" ADD CONSTRAINT "agreement_case_details_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_case_details" ADD CONSTRAINT "agreement_case_details_final_agreement_file_id_case_files_id_fk" FOREIGN KEY ("final_agreement_file_id") REFERENCES "public"."case_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_case_details" ADD CONSTRAINT "agreement_case_details_client_agreement_file_id_case_files_id_fk" FOREIGN KEY ("client_agreement_file_id") REFERENCES "public"."case_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_case_details" ADD CONSTRAINT "agreement_case_details_email_log_id_email_log_id_fk" FOREIGN KEY ("email_log_id") REFERENCES "public"."email_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreement_case_details_final_file_idx" ON "agreement_case_details" USING btree ("final_agreement_file_id");--> statement-breakpoint
CREATE INDEX "agreement_case_details_client_file_idx" ON "agreement_case_details" USING btree ("client_agreement_file_id");--> statement-breakpoint
CREATE INDEX "agreement_case_details_email_log_idx" ON "agreement_case_details" USING btree ("email_log_id");--> statement-breakpoint

INSERT INTO queues (id, name, slug, prefix, qc_enabled, created_at)
VALUES (gen_random_uuid(), 'Agreement', 'agreement', 'AG', false, now())
ON CONFLICT (slug) DO UPDATE
SET name = 'Agreement',
    prefix = 'AG',
    qc_enabled = false;
--> statement-breakpoint
INSERT INTO queue_case_sequences (queue_id, last_number)
SELECT id, 0 FROM queues
WHERE slug = 'agreement'
ON CONFLICT (queue_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Awaiting Client', 'awaiting_client', 3, 'in_progress', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 4, 'closed', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;
