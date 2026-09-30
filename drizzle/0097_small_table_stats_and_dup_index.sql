-- Small hot tables rarely reach the default analyze threshold (50 rows + 10%),
-- so the planner guessed their size and chose a nested loop that re-ran the
-- pending-MID sub-merchant aggregate per page row. A low threshold keeps their
-- statistics current; the one-off ANALYZE seeds tables that were never analyzed.
ALTER TABLE "document_review_details" SET (autovacuum_analyze_threshold = 5);--> statement-breakpoint
ALTER TABLE "agreement_case_details" SET (autovacuum_analyze_threshold = 5);--> statement-breakpoint
ALTER TABLE "user_queue_access" SET (autovacuum_analyze_threshold = 5);--> statement-breakpoint
ALTER TABLE "notifications" SET (autovacuum_analyze_threshold = 5);--> statement-breakpoint
ANALYZE "document_review_details", "agreement_case_details", "user_queue_access", "notifications", "users", "queues", "queue_stages", "merchants", "portal_mid_limit_applications", "case_files";--> statement-breakpoint
-- Exact duplicate of users_employee_id_unique (both btree on username) left
-- over from 0001; schema.ts only declares the unique constraint.
DROP INDEX IF EXISTS "users_employee_id_idx";
