CREATE TYPE "public"."case_close_outcome" AS ENUM('successful', 'unsuccessful');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('new', 'working', 'pending', 'qc', 'error', 'closed');--> statement-breakpoint
CREATE TYPE "public"."field_review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."stage_category" AS ENUM('new', 'in_progress', 'qc', 'error', 'closed');--> statement-breakpoint
CREATE TABLE "case_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"parent_id" uuid,
	"mentions" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_field_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"field_name" varchar(120) NOT NULL,
	"status" "field_review_status" DEFAULT 'pending' NOT NULL,
	"remarks" text,
	"reviewed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" varchar(64) NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_number" varchar(20) NOT NULL,
	"queue_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"owner_id" uuid,
	"current_stage_id" uuid,
	"status" "case_status" DEFAULT 'new' NOT NULL,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"close_outcome" "case_close_outcome",
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_case_number_unique" UNIQUE("case_number")
);
--> statement-breakpoint
CREATE TABLE "queue_case_sequences" (
	"queue_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"order" integer NOT NULL,
	"category" "stage_category" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "prefix" varchar(4) NOT NULL;--> statement-breakpoint
ALTER TABLE "queues" ADD COLUMN "qc_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "case_comments" ADD CONSTRAINT "case_comments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_comments" ADD CONSTRAINT "case_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_field_reviews" ADD CONSTRAINT "case_field_reviews_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_field_reviews" ADD CONSTRAINT "case_field_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_history" ADD CONSTRAINT "case_history_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_history" ADD CONSTRAINT "case_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_current_stage_id_queue_stages_id_fk" FOREIGN KEY ("current_stage_id") REFERENCES "public"."queue_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_case_sequences" ADD CONSTRAINT "queue_case_sequences_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_stages" ADD CONSTRAINT "queue_stages_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_comments_case_id_idx" ON "case_comments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_comments_author_id_idx" ON "case_comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "case_comments_parent_id_idx" ON "case_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "case_field_reviews_case_id_idx" ON "case_field_reviews" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_field_reviews_reviewed_by_idx" ON "case_field_reviews" USING btree ("reviewed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "case_field_reviews_case_field_uniq" ON "case_field_reviews" USING btree ("case_id","field_name");--> statement-breakpoint
CREATE INDEX "case_history_case_id_idx" ON "case_history" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_history_created_at_idx" ON "case_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cases_queue_id_idx" ON "cases" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX "cases_merchant_id_idx" ON "cases" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cases_case_number_idx" ON "cases" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "cases_owner_id_idx" ON "cases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "cases_current_stage_id_idx" ON "cases" USING btree ("current_stage_id");--> statement-breakpoint
CREATE INDEX "queue_stages_queue_id_idx" ON "queue_stages" USING btree ("queue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_stages_queue_slug_uniq" ON "queue_stages" USING btree ("queue_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_stages_queue_order_uniq" ON "queue_stages" USING btree ("queue_id","order");--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_prefix_unique" UNIQUE("prefix");