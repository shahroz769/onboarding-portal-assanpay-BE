-- Dead schema: nothing reads or writes mid_go_live_tokens, and users.deleted_at
-- was only ever checked, never set (deactivation goes through users.status).
DROP TABLE IF EXISTS "mid_go_live_tokens";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "deleted_at";
