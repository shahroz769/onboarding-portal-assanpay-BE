-- Merchant portal temporary passwords are no longer derived from the merchant
-- number. A random code is generated per merchant, revealed only to the case
-- owner, kept encrypted until the credentials email is sent, then cleared.
CREATE TABLE IF NOT EXISTS "merchant_portal_password_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE cascade,
  "case_id" uuid REFERENCES "cases"("id") ON DELETE set null,
  "code_ciphertext" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone,
  "superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_portal_password_codes_merchant_idx"
  ON "merchant_portal_password_codes" ("merchant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_portal_password_codes_case_idx"
  ON "merchant_portal_password_codes" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_portal_password_codes_created_by_idx"
  ON "merchant_portal_password_codes" ("created_by");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_portal_password_codes_one_active_idx"
  ON "merchant_portal_password_codes" ("merchant_id")
  WHERE "consumed_at" IS NULL AND "superseded_at" IS NULL;
--> statement-breakpoint
-- Older MID saves could carry the plaintext password in their history details.
UPDATE "case_history"
SET "details" = "details" - 'password'
WHERE "action" = 'mid_creation_saved' AND "details" ? 'password';
