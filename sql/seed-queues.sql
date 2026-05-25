-- Seed script for queues and their case sequences.
-- Run this after migrations.
-- This is idempotent: it uses ON CONFLICT DO NOTHING.

INSERT INTO queues (id, name, slug, prefix, created_at)
VALUES
  (gen_random_uuid(), 'Documents Review', 'documents-review', 'DR', now()),
  (gen_random_uuid(), 'EP Sub-Merchant Form', 'sub-merchant-form', 'SM', now()),
  (gen_random_uuid(), 'Agreement', 'agreement', 'AG', now()),
  (gen_random_uuid(), 'MID Creation', 'merchant-id', 'MI', now()),
  (gen_random_uuid(), 'Testing', 'testing', 'TS', now()),
  (gen_random_uuid(), 'Physical Agreement', 'physical-agreement', 'PA', now()),
  (gen_random_uuid(), 'WordPress Website', 'wordpress-website', 'WP', now()),
  (gen_random_uuid(), 'DialogPay Card', 'dialogpay-card', 'DP', now()),
  (gen_random_uuid(), 'Live', 'live', 'LV', now()),
  (gen_random_uuid(), 'Support Ticket', 'support-ticket', 'ST', now())
ON CONFLICT (slug) DO NOTHING;

INSERT INTO queue_case_sequences (queue_id, last_number)
SELECT id, 0 FROM queues
WHERE slug IN ('documents-review', 'sub-merchant-form', 'agreement', 'merchant-id', 'testing', 'physical-agreement', 'wordpress-website', 'dialogpay-card', 'live', 'support-ticket')
ON CONFLICT (queue_id) DO NOTHING;
