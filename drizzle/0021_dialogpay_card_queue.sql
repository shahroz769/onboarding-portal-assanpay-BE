-- DialogPay Card: tracks third-party portal merchant creation and document upload approvals.

INSERT INTO queues (id, name, slug, prefix, created_at)
VALUES (gen_random_uuid(), 'DialogPay Card', 'dialogpay-card', 'DP', now())
ON CONFLICT (slug) DO NOTHING;

INSERT INTO queue_case_sequences (queue_id, last_number)
SELECT id, 0
FROM queues
WHERE slug = 'dialogpay-card'
ON CONFLICT (queue_id) DO NOTHING;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q
WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'New',
    "order" = 1,
    category = 'new'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q
WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Working',
    "order" = 2,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Merchant Pending', 'merchant_pending', 3, 'in_progress', now()
FROM queues q
WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Merchant Pending',
    "order" = 3,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Docs Upload', 'docs_upload', 4, 'in_progress', now()
FROM queues q
WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Docs Upload',
    "order" = 4,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Docs Pending', 'docs_pending', 5, 'in_progress', now()
FROM queues q
WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Docs Pending',
    "order" = 5,
    category = 'in_progress'::stage_category;

INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 6, 'closed', now()
FROM queues q
WHERE q.slug = 'dialogpay-card'
ON CONFLICT (queue_id, slug) DO UPDATE
SET name = 'Closed',
    "order" = 6,
    category = 'closed'::stage_category;
