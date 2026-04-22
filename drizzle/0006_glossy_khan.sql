CREATE TYPE "public"."email_log_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
ALTER TYPE "public"."case_status" ADD VALUE 'awaiting_client';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'case_resubmitted';--> statement-breakpoint
CREATE TABLE "case_resubmission_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"token" varchar(86) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_resubmission_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_email" varchar(255) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"template" varchar(120) NOT NULL,
	"case_id" uuid,
	"merchant_id" uuid,
	"resend_id" varchar(255),
	"status" "email_log_status" DEFAULT 'queued' NOT NULL,
	"error_msg" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_field_reviews" ADD COLUMN "resubmitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "case_resubmission_tokens" ADD CONSTRAINT "case_resubmission_tokens_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_resubmission_tokens" ADD CONSTRAINT "case_resubmission_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_resubmission_tokens_case_id_idx" ON "case_resubmission_tokens" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "email_log_case_id_idx" ON "email_log" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "email_log_status_idx" ON "email_log" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_log_created_at_idx" ON "email_log" USING btree ("created_at");