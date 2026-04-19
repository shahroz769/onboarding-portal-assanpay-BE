ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'error';
ALTER TYPE "stage_category" ADD VALUE IF NOT EXISTS 'error';

UPDATE "queue_stages"
SET "order" = "order" + 100
WHERE "slug" IN ('new', 'working', 'pending', 'qc', 'error', 'closed');

INSERT INTO "queue_stages" ("queue_id", "name", "slug", "order", "category")
SELECT
  q."id",
  'QC',
  'qc',
  104,
  'qc'
FROM "queues" q
WHERE NOT EXISTS (
  SELECT 1
  FROM "queue_stages" qs
  WHERE qs."queue_id" = q."id"
    AND qs."slug" = 'qc'
);

INSERT INTO "queue_stages" ("queue_id", "name", "slug", "order", "category")
SELECT
  q."id",
  'Error',
  'error',
  105,
  'error'
FROM "queues" q
WHERE NOT EXISTS (
  SELECT 1
  FROM "queue_stages" qs
  WHERE qs."queue_id" = q."id"
    AND qs."slug" = 'error'
);

UPDATE "queue_stages" qs
SET "name" = mapped."name",
    "order" = mapped."order",
    "category" = mapped."category"::"stage_category"
FROM (
  VALUES
    ('new', 'New', 1, 'new'),
    ('working', 'Working', 2, 'in_progress'),
    ('pending', 'Pending', 3, 'in_progress'),
    ('qc', 'QC', 4, 'qc'),
    ('error', 'Error', 5, 'error'),
    ('closed', 'Closed', 6, 'closed')
) AS mapped("slug", "name", "order", "category")
WHERE qs."slug" = mapped."slug";

UPDATE "cases" c
SET "status" = 'error'
FROM "queue_stages" qs
WHERE c."current_stage_id" = qs."id"
  AND qs."category" = 'error';