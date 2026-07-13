INSERT INTO "queues" (
  "id",
  "name",
  "slug",
  "prefix",
  "workflow_type",
  "lifecycle",
  "revision",
  "qc_enabled",
  "sla_hours",
  "is_active",
  "created_at"
)
VALUES (
  gen_random_uuid(),
  'Live',
  'live',
  'LV',
  'live',
  'active',
  1,
  false,
  24,
  true,
  now()
)
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

INSERT INTO "queue_case_sequences" ("queue_id", "last_number")
SELECT "id", 0
FROM "queues"
WHERE "slug" = 'live'
ON CONFLICT ("queue_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "queue_stages" (
  "id",
  "queue_id",
  "name",
  "slug",
  "order",
  "category",
  "is_active",
  "created_at"
)
SELECT
  gen_random_uuid(),
  live_queue."id",
  stage."name",
  stage."slug",
  stage."order",
  stage."category"::"stage_category",
  true,
  now()
FROM "queues" live_queue
CROSS JOIN (
  VALUES
    ('New', 'new', 1, 'new'),
    ('Working', 'working', 2, 'in_progress'),
    ('Closed', 'closed', 3, 'closed')
) AS stage("name", "slug", "order", "category")
WHERE live_queue."slug" = 'live'
  AND NOT EXISTS (
    SELECT 1
    FROM "queue_stages" existing_stage
    WHERE existing_stage."queue_id" = live_queue."id"
  );
