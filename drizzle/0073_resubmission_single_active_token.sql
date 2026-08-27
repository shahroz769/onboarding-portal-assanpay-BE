WITH ranked_active_tokens AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "case_id"
      ORDER BY "created_at" DESC, "id" DESC
    ) AS "active_rank"
  FROM "case_resubmission_tokens"
  WHERE "consumed_at" IS NULL
)
UPDATE "case_resubmission_tokens" AS "token"
SET "consumed_at" = now()
FROM "ranked_active_tokens" AS "ranked"
WHERE "token"."id" = "ranked"."id"
  AND "ranked"."active_rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_resubmission_tokens_one_active_per_case_idx"
  ON "case_resubmission_tokens" ("case_id")
  WHERE "consumed_at" IS NULL;
