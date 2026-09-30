-- Each MID Creation case's latest saved portal/internal MID. The dashboard's
-- pending and applied MID queries read this instead of re-parsing every
-- `mid_creation_saved` history row on each request. Only the MID values live
-- here: case status/outcome, queue and merchant deletion are still read from
-- their own tables, so nothing else has to keep this in sync.
CREATE TABLE IF NOT EXISTS "mid_case_portal_mids" (
  "case_id" uuid PRIMARY KEY NOT NULL,
  "portal_mid" integer NOT NULL,
  "internal_portal_mid" integer,
  "saved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mid_case_portal_mids" ADD CONSTRAINT "mid_case_portal_mids_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Kept current by the database, so every writer of `mid_creation_saved`
-- (the MID case service, the demo seed) is covered, including saves made by
-- the previous release between this migration and the deploy.
CREATE OR REPLACE FUNCTION "sync_mid_case_portal_mids"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW."details" ->> 'portalMid') ~ '^[0-9]+$' THEN
    INSERT INTO "mid_case_portal_mids" (
      "case_id",
      "portal_mid",
      "internal_portal_mid",
      "saved_at"
    )
    VALUES (
      NEW."case_id",
      (NEW."details" ->> 'portalMid')::integer,
      CASE
        WHEN (NEW."details" ->> 'internalPortalMid') ~ '^[0-9]+$'
          THEN (NEW."details" ->> 'internalPortalMid')::integer
      END,
      NEW."created_at"
    )
    ON CONFLICT ("case_id") DO UPDATE SET
      "portal_mid" = EXCLUDED."portal_mid",
      "internal_portal_mid" = EXCLUDED."internal_portal_mid",
      "saved_at" = EXCLUDED."saved_at"
    WHERE "mid_case_portal_mids"."saved_at" <= EXCLUDED."saved_at";
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "case_history_sync_mid_case_portal_mids" ON "case_history";
--> statement-breakpoint
CREATE TRIGGER "case_history_sync_mid_case_portal_mids"
AFTER INSERT ON "case_history"
FOR EACH ROW
WHEN (NEW."action" = 'mid_creation_saved')
EXECUTE FUNCTION "sync_mid_case_portal_mids"();
--> statement-breakpoint

-- Backfill: each case's latest save with a numeric portal MID.
INSERT INTO "mid_case_portal_mids" (
  "case_id",
  "portal_mid",
  "internal_portal_mid",
  "saved_at"
)
SELECT DISTINCT ON ("case_id")
  "case_id",
  ("details" ->> 'portalMid')::integer,
  CASE
    WHEN ("details" ->> 'internalPortalMid') ~ '^[0-9]+$'
      THEN ("details" ->> 'internalPortalMid')::integer
  END,
  "created_at"
FROM "case_history"
WHERE "action" = 'mid_creation_saved'
  AND ("details" ->> 'portalMid') ~ '^[0-9]+$'
ORDER BY "case_id", "created_at" DESC
ON CONFLICT ("case_id") DO NOTHING;
--> statement-breakpoint

-- Legacy applications saved before categories existed: store the category the
-- dashboard used to derive on every request (internal MID, else the merchant's
-- website CMS), so the applied list can read the column directly.
WITH "latest_mid" AS (
  -- Each merchant's latest saved MIDs, as the applied list resolved them.
  SELECT DISTINCT ON ("cases"."merchant_id")
    "cases"."merchant_id",
    "merchants"."website_cms",
    "mid"."portal_mid",
    "mid"."internal_portal_mid",
    "mid"."saved_at"
  FROM "mid_case_portal_mids" AS "mid"
  INNER JOIN "cases" ON "cases"."id" = "mid"."case_id"
  INNER JOIN "queues" ON "queues"."id" = "cases"."queue_id"
  INNER JOIN "merchants" ON "merchants"."id" = "cases"."merchant_id"
  WHERE "queues"."slug" = 'merchant-id'
    AND "merchants"."deleted_at" IS NULL
  ORDER BY "cases"."merchant_id", "mid"."saved_at" DESC
),
"classified" AS (
  SELECT "merchant_id", "website_cms", "portal_mid" AS "mid", 'portal' AS "mid_kind", "saved_at"
  FROM "latest_mid"
  UNION ALL
  SELECT "merchant_id", "website_cms", "internal_portal_mid", 'internal', "saved_at"
  FROM "latest_mid"
  WHERE "internal_portal_mid" IS NOT NULL
    AND "internal_portal_mid" <> "portal_mid"
)
UPDATE "portal_mid_limit_applications" AS "application"
SET "category" = coalesce(
  (
    SELECT
      CASE
        WHEN "classified"."mid_kind" = 'internal' THEN 'internal'
        WHEN "classified"."website_cms" = 'shopify' THEN 'shopify'
        ELSE 'custom_wordpress'
      END
    FROM "classified"
    WHERE "classified"."mid" = "application"."portal_mid"
    ORDER BY
      CASE WHEN "classified"."merchant_id" = "application"."merchant_id" THEN 0 ELSE 1 END,
      "classified"."saved_at" DESC
    LIMIT 1
  ),
  'custom_wordpress'
)
WHERE "application"."category" IS NULL;
--> statement-breakpoint
ALTER TABLE "portal_mid_limit_applications" ALTER COLUMN "category" SET NOT NULL;
