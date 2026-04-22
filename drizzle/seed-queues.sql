-- Seed script for queues and their case sequences.
-- Run this AFTER the migration that creates queues.prefix, cases, and queue_case_sequences tables.
-- This is idempotent: it uses ON CONFLICT DO NOTHING.

INSERT INTO queues (id, name, slug, prefix, created_at)
VALUES
  (gen_random_uuid(), 'Documents Review', 'documents-review', 'DR', now()),
  (gen_random_uuid(), 'Sub Merchant Form', 'sub-merchant-form', 'SM', now()),
  (gen_random_uuid(), 'Agreement', 'agreement', 'AG', now()),
  (gen_random_uuid(), 'Merchant ID', 'merchant-id', 'MI', now()),
  (gen_random_uuid(), 'Live', 'live', 'LV', now()),
  (gen_random_uuid(), 'Support Ticket', 'support-ticket', 'ST', now())
ON CONFLICT (slug) DO NOTHING;

-- Insert sequence rows for each queue
INSERT INTO queue_case_sequences (queue_id, last_number)
SELECT id, 0 FROM queues
WHERE slug IN ('documents-review', 'sub-merchant-form', 'agreement', 'merchant-id', 'live', 'support-ticket')
ON CONFLICT (queue_id) DO NOTHING;
