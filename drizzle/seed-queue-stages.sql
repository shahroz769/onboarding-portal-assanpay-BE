-- Seed script for queue_stages.
-- Queue stages are queue-specific. Only the documents-review workflow is
-- seeded here. Other queues should be seeded explicitly when their workflow
-- is finalized.
-- This script is idempotent: it uses ON CONFLICT DO NOTHING on the unique
-- (queue_id, slug) index.

-- Documents Review: New -> Working -> Awaiting Client -> Closed
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Awaiting Client', 'awaiting_client', 3, 'in_progress', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 4, 'closed', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT (queue_id, slug) DO NOTHING;

-- Backfill existing documents-review cases that do not have a current stage.
UPDATE cases c
SET current_stage_id = qs.id
FROM queue_stages qs
INNER JOIN queues q ON q.id = c.queue_id
WHERE q.slug = 'documents-review'
  AND qs.queue_id = c.queue_id
  AND qs.slug = CASE c.status
    WHEN 'new' THEN 'new'
    WHEN 'working' THEN 'working'
    WHEN 'awaiting_client' THEN 'awaiting_client'
    WHEN 'closed' THEN 'closed'
    WHEN 'error' THEN 'closed'
  END
  AND c.current_stage_id IS NULL;

-- EP Sub-Merchant Form: New -> Working -> Closed
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT (queue_id, slug) DO NOTHING;

-- Agreement: New -> Working -> Awaiting Client -> Closed
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Awaiting Client', 'awaiting_client', 3, 'in_progress', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 4, 'closed', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT (queue_id, slug) DO NOTHING;

-- MID Creation: New -> Working -> Closed
DELETE FROM queue_stages qs
USING queues q
WHERE q.id = qs.queue_id
  AND q.slug = 'merchant-id'
  AND qs.slug NOT IN ('new', 'working', 'closed');

UPDATE queue_stages qs
SET "order" = -ABS(qs."order")
FROM queues q
WHERE q.id = qs.queue_id
  AND q.slug = 'merchant-id'
  AND qs.slug IN ('new', 'working', 'closed');

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'New',
    "order" = 1,
    category = 'new'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Working',
    "order" = 2,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Closed',
    "order" = 3,
    category = 'closed'::stage_category;

UPDATE cases c
SET current_stage_id = qs.id
FROM queues q
INNER JOIN queue_stages qs ON qs.queue_id = q.id
WHERE q.id = c.queue_id
  AND q.slug = 'merchant-id'
  AND qs.slug = CASE c.status
    WHEN 'new' THEN 'new'
    WHEN 'working' THEN 'working'
    WHEN 'closed' THEN 'closed'
    WHEN 'error' THEN 'closed'
    ELSE 'working'
  END
  AND (
    c.current_stage_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM queue_stages current_qs
      WHERE current_qs.id = c.current_stage_id
        AND current_qs.queue_id = c.queue_id
        AND current_qs.slug IN ('new', 'working', 'closed')
    )
  );

-- Testing: New -> Working -> Closed
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'testing'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'New',
    "order" = 1,
    category = 'new'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'testing'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Working',
    "order" = 2,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'testing'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Closed',
    "order" = 3,
    category = 'closed'::stage_category;

-- Live: New -> Working -> Closed
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT (queue_id, slug) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT (queue_id, slug) DO NOTHING;

-- DialogPay Card: New -> Working -> Merchant Pending -> Docs Upload -> Docs Pending -> Closed
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'New',
    "order" = 1,
    category = 'new'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Working',
    "order" = 2,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Merchant Pending', 'merchant_pending', 3, 'in_progress', now()
FROM queues q WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Merchant Pending',
    "order" = 3,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Docs Upload', 'docs_upload', 4, 'in_progress', now()
FROM queues q WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Docs Upload',
    "order" = 4,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Docs Pending', 'docs_pending', 5, 'in_progress', now()
FROM queues q WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Docs Pending',
    "order" = 5,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 6, 'closed', now()
FROM queues q WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Closed',
    "order" = 6,
    category = 'closed'::stage_category;
