CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_list_created_idx" ON "cases" USING btree ("created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_case_number_id_idx" ON "cases" USING btree ("case_number", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_status_id_idx" ON "cases" USING btree ("status", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_closed_id_idx" ON "cases" USING btree ("closed_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_closed_coalesce_id_idx" ON "cases" USING btree (coalesce("closed_at", '0001-01-01 00:00:00+00'::timestamptz), "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_updated_id_idx" ON "cases" USING btree ("updated_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_queue_created_idx" ON "cases" USING btree ("queue_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_owner_created_idx" ON "cases" USING btree ("owner_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_status_created_idx" ON "cases" USING btree ("status", "created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_case_number_trgm_idx" ON "cases" USING gin ("case_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_active_number_idx" ON "merchants" USING btree ("merchant_number", "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_active_created_idx" ON "merchants" USING btree ("created_at", "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_active_business_name_lower_idx" ON "merchants" USING btree (lower("business_name"), "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_active_stage_created_idx" ON "merchants" USING btree ("onboarding_stage", "created_at", "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_active_priority_created_idx" ON "merchants" USING btree ("priority", "created_at", "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_active_status_id_idx" ON "merchants" USING btree ("status", "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_active_scope_id_idx" ON "merchants" USING btree ("business_scope", "id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_business_name_trgm_idx" ON "merchants" USING gin ("business_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchants_submitter_email_trgm_idx" ON "merchants" USING gin ("submitter_email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_created_id_idx" ON "notifications" USING btree ("user_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_unread_created_id_idx" ON "notifications" USING btree ("user_id", "is_read", "created_at", "id");
