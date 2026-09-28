-- Merchant portal API key and secret for the internal merchant ID. Saved by
-- the MID Creation owner, revealed only to the working case owner, kept
-- encrypted, and deleted when the WordPress Website case closes.
CREATE TABLE IF NOT EXISTS "merchant_portal_api_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE cascade,
  "case_id" uuid REFERENCES "cases"("id") ON DELETE set null,
  "api_key_ciphertext" text NOT NULL,
  "api_secret_ciphertext" text NOT NULL,
  "api_key_last4" varchar(4) NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_portal_api_credentials_merchant_idx"
  ON "merchant_portal_api_credentials" ("merchant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_portal_api_credentials_case_idx"
  ON "merchant_portal_api_credentials" ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_portal_api_credentials_updated_by_idx"
  ON "merchant_portal_api_credentials" ("updated_by");
