ALTER TABLE "cases" ADD COLUMN "priority" "priority" DEFAULT 'normal' NOT NULL;

-- Inherit priority from merchant for all existing cases
UPDATE "cases" c
SET "priority" = m."priority"
FROM "merchants" m
WHERE c."merchant_id" = m."id";
