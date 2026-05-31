ALTER TYPE "merchant_status" RENAME TO "merchant_status_old";

CREATE TYPE "merchant_status" AS ENUM (
  'pending',
  'testing',
  'live',
  'terminated'
);

ALTER TABLE "merchants"
ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "merchants"
ALTER COLUMN "status" TYPE "merchant_status"
USING (
  CASE
    WHEN "status"::text = 'testing' THEN 'testing'::"merchant_status"
    WHEN "status"::text = 'live' THEN 'live'::"merchant_status"
    WHEN "status"::text IN ('terminated', 'suspended') THEN 'terminated'::"merchant_status"
    ELSE 'pending'::"merchant_status"
  END
);

ALTER TABLE "merchants"
ALTER COLUMN "status" SET DEFAULT 'pending';

DROP INDEX IF EXISTS "merchants_active_stage_created_idx";

ALTER TABLE "merchants"
DROP COLUMN IF EXISTS "onboarding_stage";

DROP TYPE "merchant_status_old";