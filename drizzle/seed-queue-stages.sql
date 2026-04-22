-- Seed script for queue_stages.
-- Each queue gets a default pipeline: New → Working → QC → Closed
-- Custom stages can be inserted between Working and QC later.
-- This is idempotent: uses ON CONFLICT DO NOTHING on the unique (queue_id, slug) constraint.

-- Documents Review
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 0, 'new', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 1, 'in_progress', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Quality Check', 'qc', 2, 'qc', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'documents-review'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

-- Sub Merchant Form
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 0, 'new', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 1, 'in_progress', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Quality Check', 'qc', 2, 'qc', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'sub-merchant-form'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

-- Agreement
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 0, 'new', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 1, 'in_progress', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Quality Check', 'qc', 2, 'qc', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'agreement'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

-- Merchant ID
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 0, 'new', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 1, 'in_progress', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Quality Check', 'qc', 2, 'qc', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'merchant-id'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

-- Live
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 0, 'new', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 1, 'in_progress', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Quality Check', 'qc', 2, 'qc', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

-- Support Ticket
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 0, 'new', now()
FROM queues q WHERE q.slug = 'support-ticket'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 1, 'in_progress', now()
FROM queues q WHERE q.slug = 'support-ticket'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Quality Check', 'qc', 2, 'qc', now()
FROM queues q WHERE q.slug = 'support-ticket'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'support-ticket'
ON CONFLICT ON CONSTRAINT queue_stages_queue_slug_uniq DO NOTHING;

-- Backfill existing cases: set current_stage_id based on current status
-- Maps: new → 'new' stage, working/pending → 'working' stage, qc → 'qc' stage, closed → 'closed' stage
UPDATE cases c
SET current_stage_id = qs.id
FROM queue_stages qs
WHERE qs.queue_id = c.queue_id
  AND qs.slug = CASE c.status
    WHEN 'new' THEN 'new'
    WHEN 'working' THEN 'working'
    WHEN 'pending' THEN 'working'
    WHEN 'qc' THEN 'qc'
    WHEN 'closed' THEN 'closed'
  END
  AND c.current_stage_id IS NULL;
