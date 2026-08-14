CREATE TABLE "case_flow_close_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_case_id" uuid NOT NULL,
  "merchant_id" uuid NOT NULL,
  "source_queue_id" uuid NOT NULL,
  "target_queue_id" uuid NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "completed_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "case_flow_close_jobs_attempts_nonnegative" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "case_flow_close_jobs" ADD CONSTRAINT "case_flow_close_jobs_source_case_id_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "case_flow_close_jobs" ADD CONSTRAINT "case_flow_close_jobs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "case_flow_close_jobs" ADD CONSTRAINT "case_flow_close_jobs_source_queue_id_queues_id_fk" FOREIGN KEY ("source_queue_id") REFERENCES "public"."queues"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "case_flow_close_jobs" ADD CONSTRAINT "case_flow_close_jobs_target_queue_id_queues_id_fk" FOREIGN KEY ("target_queue_id") REFERENCES "public"."queues"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "case_flow_close_jobs_source_target_unique" ON "case_flow_close_jobs" USING btree ("source_case_id", "target_queue_id");
CREATE INDEX "case_flow_close_jobs_pending_idx" ON "case_flow_close_jobs" USING btree ("available_at", "created_at") WHERE "completed_at" IS NULL AND "failed_at" IS NULL;
CREATE INDEX "case_flow_close_jobs_merchant_idx" ON "case_flow_close_jobs" USING btree ("merchant_id");
CREATE INDEX "case_flow_close_jobs_source_queue_idx" ON "case_flow_close_jobs" USING btree ("source_queue_id");
CREATE INDEX "case_flow_close_jobs_target_queue_idx" ON "case_flow_close_jobs" USING btree ("target_queue_id");
