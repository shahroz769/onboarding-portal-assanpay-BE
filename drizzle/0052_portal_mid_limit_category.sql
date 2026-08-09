ALTER TABLE "portal_mid_limit_applications"
  ADD COLUMN IF NOT EXISTS "category" varchar(32);

ALTER TABLE "portal_mid_limit_applications"
  ADD CONSTRAINT "portal_mid_limit_applications_category_valid"
  CHECK (
    "category" IS NULL
    OR "category" IN ('custom_wordpress', 'shopify', 'internal')
  ) NOT VALID;

ALTER TABLE "portal_mid_limit_applications"
  VALIDATE CONSTRAINT "portal_mid_limit_applications_category_valid";
