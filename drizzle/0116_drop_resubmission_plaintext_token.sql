-- Resubmission links are stored only as token_hash since 0041, which hashed
-- every token and cleared this column; nothing has written it since. Dropping
-- it (with its unique constraint) means a plaintext link can never be stored
-- or accepted again. Refuses to run if any plaintext value somehow exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'case_resubmission_tokens' AND column_name = 'token'
  ) AND EXISTS (
    SELECT 1 FROM "case_resubmission_tokens" WHERE "token" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'case_resubmission_tokens.token still holds plaintext values; hash them before dropping the column';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "case_resubmission_tokens" DROP COLUMN IF EXISTS "token";
