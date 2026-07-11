CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "case_resubmission_tokens"
  ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "case_resubmission_tokens"
  ADD COLUMN IF NOT EXISTS "token_hash" varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS "case_resubmission_tokens_token_hash_unique"
  ON "case_resubmission_tokens" ("token_hash");
UPDATE "case_resubmission_tokens"
  SET "token_hash" = encode(digest("token", 'sha256'), 'hex')
  WHERE "token" IS NOT NULL AND "token_hash" IS NULL;
UPDATE "case_resubmission_tokens" SET "token" = NULL WHERE "token" IS NOT NULL;

ALTER TABLE "mid_go_live_tokens"
  ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "mid_go_live_tokens"
  ADD COLUMN IF NOT EXISTS "token_hash" varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS "mid_go_live_tokens_token_hash_unique"
  ON "mid_go_live_tokens" ("token_hash");
UPDATE "mid_go_live_tokens"
  SET "token_hash" = encode(digest("token", 'sha256'), 'hex')
  WHERE "token" IS NOT NULL AND "token_hash" IS NULL;
UPDATE "mid_go_live_tokens" SET "token" = NULL WHERE "token" IS NOT NULL;
