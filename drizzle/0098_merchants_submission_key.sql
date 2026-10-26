-- Public onboarding submissions carry an Idempotency-Key; its SHA-256 lets a
-- retried request return the merchant it already created. Nullable: older
-- rows and clients without the header have none.
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "submission_key_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchants_submission_key_hash_unique" ON "merchants" ("submission_key_hash") WHERE "submission_key_hash" IS NOT NULL;
