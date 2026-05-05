-- MID Creation queue: ensure queue exists, rename label, and seed stages.
-- Workflow: New -> Working -> Closed.

INSERT INTO queues (id, name, slug, prefix, qc_enabled, created_at)
VALUES (gen_random_uuid(), 'MID Creation', 'merchant-id', 'MI', false, now())
ON CONFLICT (slug) DO UPDATE
SET name = 'MID Creation',
    prefix = 'MI',
    qc_enabled = false;
--> statement-breakpoint
INSERT INTO queue_case_sequences (queue_id, last_number)
SELECT id, 0 FROM queues
WHERE slug = 'merchant-id'
ON CONFLICT (queue_id) DO NOTHING;
--> statement-breakpoint
DELETE FROM queue_stages qs
USING queues q
WHERE q.id = qs.queue_id
  AND q.slug = 'merchant-id'
  AND qs.slug NOT IN ('new', 'working', 'closed');
--> statement-breakpoint
UPDATE queue_stages qs
SET "order" = -ABS(qs."order")
FROM queues q
WHERE q.id = qs.queue_id
  AND q.slug = 'merchant-id'
  AND qs.slug IN ('new', 'working', 'closed');
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'New',
    "order" = 1,
    category = 'new'::stage_category;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Working',
    "order" = 2,
    category = 'in_progress'::stage_category;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Closed',
    "order" = 3,
    category = 'closed'::stage_category;
--> statement-breakpoint
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
