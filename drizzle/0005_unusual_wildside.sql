CREATE TYPE "public"."case_status" AS ENUM('new', 'working', 'pending', 'qc', 'closed');--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_number" varchar(20) NOT NULL,
	"queue_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"owner_id" uuid,
	"status" "case_status" DEFAULT 'new' NOT NULL,
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
ALTER TABLE "queues" ADD COLUMN "prefix" varchar(4) NOT NULL;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_case_sequences" ADD CONSTRAINT "queue_case_sequences_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_queue_id_idx" ON "cases" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX "cases_merchant_id_idx" ON "cases" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cases_case_number_idx" ON "cases" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "cases_owner_id_idx" ON "cases" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_prefix_unique" UNIQUE("prefix");