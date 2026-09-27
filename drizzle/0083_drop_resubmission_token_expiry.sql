-- Document-review resubmission links no longer expire; a link stays valid until
-- it is used or superseded by a newer link for the same case.
ALTER TABLE "case_resubmission_tokens" DROP COLUMN IF EXISTS "expires_at";
