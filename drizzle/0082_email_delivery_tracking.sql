-- Resend delivery tracking and extra recipients for email_log.
--
-- Webhook events (email.delivered, email.bounced, ...) now move an email past
-- 'sent' (which only means Resend accepted it). delivery_tracked marks emails
-- sent while webhooks were configured: only those can gate closing a case,
-- since older rows never receive events. cc / bcc / reply_to record who else
-- each email went to.
ALTER TYPE "email_log_status" ADD VALUE IF NOT EXISTS 'delivered';
--> statement-breakpoint
ALTER TYPE "email_log_status" ADD VALUE IF NOT EXISTS 'delivery_delayed';
--> statement-breakpoint
ALTER TYPE "email_log_status" ADD VALUE IF NOT EXISTS 'bounced';
--> statement-breakpoint
ALTER TYPE "email_log_status" ADD VALUE IF NOT EXISTS 'complained';
--> statement-breakpoint
ALTER TYPE "email_log_status" ADD VALUE IF NOT EXISTS 'suppressed';
--> statement-breakpoint
ALTER TABLE "email_log"
  ADD COLUMN IF NOT EXISTS "cc_emails" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bcc_emails" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reply_to" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN IF NOT EXISTS "status_detail" text,
  ADD COLUMN IF NOT EXISTS "status_updated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "delivery_tracked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_log_resend_id_idx" ON "email_log" ("resend_id");
--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'case_email_undelivered';
