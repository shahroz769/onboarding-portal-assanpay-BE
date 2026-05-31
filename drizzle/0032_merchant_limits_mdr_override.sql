ALTER TABLE "merchants"
ADD COLUMN IF NOT EXISTS "limits_mdr_override" jsonb;
