ALTER TABLE "case_flow_close_jobs" ADD COLUMN IF NOT EXISTS "failed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_flow_close_jobs_pending_idx" ON "case_flow_close_jobs" USING btree ("available_at", "created_at") WHERE "completed_at" IS NULL AND "failed_at" IS NULL;
