-- Seed script for queue_stages.
-- Queue stages are queue-specific. Only the documents-review workflow is
-- seeded here. Other queues should be seeded explicitly when their workflow
-- is finalized.
-- This script is idempotent: it uses ON CONFLICT DO NOTHING on the unique
-- (queue_id, slug) constraint.

-- Documents Review: New -> Working -> Awaiting Client -> Closed
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Awaiting Client', 'awaiting_client', 3, 'in_progress', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 4, 'closed', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

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
