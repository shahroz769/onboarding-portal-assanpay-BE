CREATE TABLE IF NOT EXISTS "portal_mid_limit_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "portal_mid" integer NOT NULL,
  "merchant_id" uuid,
  "applied_by" uuid,
  "applied_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "portal_mid_limit_applications_portal_mid_unique" UNIQUE("portal_mid")
);
--> statement-breakpoint
ALTER TABLE "portal_mid_limit_applications" ADD CONSTRAINT "portal_mid_limit_applications_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "portal_mid_limit_applications" ADD CONSTRAINT "portal_mid_limit_applications_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_mid_limit_applications_mid_idx" ON "portal_mid_limit_applications" USING btree ("portal_mid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_mid_limit_applications_merchant_idx" ON "portal_mid_limit_applications" USING btree ("merchant_id");
