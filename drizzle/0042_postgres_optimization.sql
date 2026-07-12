ALTER TABLE "case_field_reviews" ALTER COLUMN "reviewed_by" DROP NOT NULL;
ALTER TABLE "case_comments" ALTER COLUMN "author_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL NOT VALID;
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_replaced_by_token_id_refresh_tokens_id_fk"
  FOREIGN KEY ("replaced_by_token_id") REFERENCES "refresh_tokens"("id")
  ON DELETE SET NULL NOT VALID;
ALTER TABLE "case_comments"
  ADD CONSTRAINT "case_comments_parent_id_case_comments_id_fk"
  FOREIGN KEY ("parent_id") REFERENCES "case_comments"("id")
  ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_session_version_nonnegative"
  CHECK ("session_version" >= 0) NOT VALID;
ALTER TABLE "queues" ADD CONSTRAINT "queues_sla_hours_positive"
  CHECK ("sla_hours" > 0) NOT VALID;
ALTER TABLE "queue_stages" ADD CONSTRAINT "queue_stages_order_positive"
  CHECK ("order" > 0) NOT VALID;
ALTER TABLE "queue_case_sequences" ADD CONSTRAINT "queue_case_sequences_last_number_nonnegative"
  CHECK ("last_number" >= 0) NOT VALID;
ALTER TABLE "case_flow_start_rules" ADD CONSTRAINT "case_flow_start_rules_order_positive"
  CHECK ("order" > 0) NOT VALID;
ALTER TABLE "case_flow_close_triggers" ADD CONSTRAINT "case_flow_close_triggers_order_positive"
  CHECK ("order" > 0) NOT VALID;
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_transactions_nonnegative"
  CHECK ("estimated_monthly_transactions" >= 0) NOT VALID;
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_volume_nonnegative"
  CHECK ("estimated_monthly_volume" >= 0) NOT VALID;
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_size_nonnegative"
  CHECK ("size_bytes" >= 0) NOT VALID;
ALTER TABLE "agreement_draft_templates" ADD CONSTRAINT "agreement_draft_templates_size_nonnegative"
  CHECK ("size_bytes" >= 0) NOT VALID;
ALTER TABLE "sub_merchant_draft_templates" ADD CONSTRAINT "sub_merchant_draft_templates_size_nonnegative"
  CHECK ("size_bytes" >= 0) NOT VALID;
ALTER TABLE "case_files" ADD CONSTRAINT "case_files_size_nonnegative"
  CHECK ("size_bytes" >= 0) NOT VALID;
ALTER TABLE "portal_mid_limit_applications" ADD CONSTRAINT "portal_mid_limit_applications_mid_positive"
  CHECK ("portal_mid" > 0) NOT VALID;
--> statement-breakpoint

ALTER TABLE "users" VALIDATE CONSTRAINT "users_created_by_user_id_users_id_fk";
ALTER TABLE "refresh_tokens" VALIDATE CONSTRAINT "refresh_tokens_replaced_by_token_id_refresh_tokens_id_fk";
ALTER TABLE "case_comments" VALIDATE CONSTRAINT "case_comments_parent_id_case_comments_id_fk";
ALTER TABLE "users" VALIDATE CONSTRAINT "users_session_version_nonnegative";
ALTER TABLE "queues" VALIDATE CONSTRAINT "queues_sla_hours_positive";
ALTER TABLE "queue_stages" VALIDATE CONSTRAINT "queue_stages_order_positive";
ALTER TABLE "queue_case_sequences" VALIDATE CONSTRAINT "queue_case_sequences_last_number_nonnegative";
ALTER TABLE "case_flow_start_rules" VALIDATE CONSTRAINT "case_flow_start_rules_order_positive";
ALTER TABLE "case_flow_close_triggers" VALIDATE CONSTRAINT "case_flow_close_triggers_order_positive";
ALTER TABLE "merchants" VALIDATE CONSTRAINT "merchants_transactions_nonnegative";
ALTER TABLE "merchants" VALIDATE CONSTRAINT "merchants_volume_nonnegative";
ALTER TABLE "merchant_documents" VALIDATE CONSTRAINT "merchant_documents_size_nonnegative";
ALTER TABLE "agreement_draft_templates" VALIDATE CONSTRAINT "agreement_draft_templates_size_nonnegative";
ALTER TABLE "sub_merchant_draft_templates" VALIDATE CONSTRAINT "sub_merchant_draft_templates_size_nonnegative";
ALTER TABLE "case_files" VALIDATE CONSTRAINT "case_files_size_nonnegative";
ALTER TABLE "portal_mid_limit_applications" VALIDATE CONSTRAINT "portal_mid_limit_applications_mid_positive";
--> statement-breakpoint

DROP INDEX IF EXISTS "users_email_idx";
DROP INDEX IF EXISTS "users_username_idx";
DROP INDEX IF EXISTS "user_queue_access_user_idx";
DROP INDEX IF EXISTS "user_password_tokens_token_hash_idx";
DROP INDEX IF EXISTS "merchants_number_idx";
DROP INDEX IF EXISTS "cases_merchant_id_idx";
DROP INDEX IF EXISTS "cases_case_number_idx";
DROP INDEX IF EXISTS "case_field_reviews_case_id_idx";
DROP INDEX IF EXISTS "case_comments_case_id_idx";
DROP INDEX IF EXISTS "case_history_case_id_idx";
DROP INDEX IF EXISTS "case_history_created_at_idx";
DROP INDEX IF EXISTS "case_flow_close_blockers_blocked_idx";
DROP INDEX IF EXISTS "case_flow_creation_requirements_target_idx";
DROP INDEX IF EXISTS "notifications_user_id_idx";
DROP INDEX IF EXISTS "notifications_user_unread_idx";
DROP INDEX IF EXISTS "case_files_case_id_idx";
ALTER TABLE "portal_mid_limit_applications"
  DROP CONSTRAINT IF EXISTS "portal_mid_limit_applications_portal_mid_unique";
DROP INDEX IF EXISTS "merchants_active_priority_created_idx";
--> statement-breakpoint

CREATE INDEX "users_created_by_idx" ON "users" ("created_by_user_id");
CREATE INDEX "user_password_tokens_created_by_idx" ON "user_password_tokens" ("created_by");
CREATE INDEX "refresh_tokens_replaced_by_idx" ON "refresh_tokens" ("replaced_by_token_id");
CREATE INDEX "cases_merchant_queue_idx" ON "cases" ("merchant_id", "queue_id");
CREATE INDEX "cases_open_merchant_idx" ON "cases" ("merchant_id", "queue_id")
  WHERE "status" NOT IN ('closed', 'error');
CREATE INDEX "cases_successful_flow_idx" ON "cases" ("merchant_id", "queue_id")
  WHERE "status" = 'closed' AND "close_outcome" = 'successful';
CREATE INDEX "merchants_active_priority_created_idx" ON "merchants" ("priority", "id")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "case_comments_case_created_idx" ON "case_comments" ("case_id", "created_at", "id");
CREATE INDEX "case_history_case_action_created_idx" ON "case_history" ("case_id", "action", "created_at");
CREATE INDEX "case_history_case_created_idx" ON "case_history" ("case_id", "created_at", "id");
CREATE INDEX "case_history_actor_idx" ON "case_history" ("actor_id");
CREATE INDEX "case_flow_close_triggers_target_idx" ON "case_flow_close_triggers" ("target_queue_id");
CREATE INDEX "case_flow_close_blockers_prerequisite_idx" ON "case_flow_close_blockers" ("prerequisite_queue_id");
CREATE INDEX "case_flow_creation_requirements_prerequisite_idx" ON "case_flow_creation_requirements" ("prerequisite_queue_id");
CREATE INDEX "case_links_source_queue_idx" ON "case_links" ("source_queue_id");
CREATE INDEX "case_links_target_queue_idx" ON "case_links" ("target_queue_id");
CREATE INDEX "case_resubmission_tokens_created_by_idx" ON "case_resubmission_tokens" ("created_by");
CREATE INDEX "email_log_merchant_id_idx" ON "email_log" ("merchant_id");
CREATE INDEX "mid_go_live_tokens_live_case_idx" ON "mid_go_live_tokens" ("live_case_id");
CREATE INDEX "mid_go_live_tokens_created_by_idx" ON "mid_go_live_tokens" ("created_by");
CREATE INDEX "portal_mid_limit_applications_applied_by_idx" ON "portal_mid_limit_applications" ("applied_by");
CREATE INDEX "notifications_actor_idx" ON "notifications" ("actor_id");
CREATE INDEX "notifications_case_idx" ON "notifications" ("case_id");
CREATE INDEX "notifications_comment_idx" ON "notifications" ("comment_id");
