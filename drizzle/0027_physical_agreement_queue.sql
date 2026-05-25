-- Physical Agreement queue: New -> Working -> Closed.

INSERT INTO queues (id, name, slug, prefix, qc_enabled, created_at)
VALUES (gen_random_uuid(), 'Physical Agreement', 'physical-agreement', 'PA', false, now())
ON CONFLICT (slug) DO UPDATE
SET name = 'Physical Agreement',
    prefix = 'PA',
    qc_enabled = false;
--> statement-breakpoint
INSERT INTO queue_case_sequences (queue_id, last_number)
SELECT id, 0 FROM queues
WHERE slug = 'physical-agreement'
ON CONFLICT (queue_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'physical-agreement'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'New',
    "order" = 1,
    category = 'new'::stage_category;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'physical-agreement'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Working',
    "order" = 2,
    category = 'in_progress'::stage_category;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'physical-agreement'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Closed',
    "order" = 3,
    category = 'closed'::stage_category;