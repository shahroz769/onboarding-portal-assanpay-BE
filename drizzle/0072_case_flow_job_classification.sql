ALTER TABLE "case_flow_close_jobs"
  ADD COLUMN "last_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "case_flow_close_jobs"
  ADD COLUMN "blocked_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "case_flow_close_jobs_problem_idx"
  ON "case_flow_close_jobs" USING btree ("last_attempt_at", "created_at")
  WHERE "completed_at" IS NULL AND "last_error" IS NOT NULL;
