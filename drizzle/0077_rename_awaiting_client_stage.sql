-- Product copy uses "merchant" everywhere; rename the default stage label.
-- Only untouched default names are changed; admin-customised names are kept.
UPDATE queue_stages SET name = 'Awaiting Merchant'
WHERE slug = 'awaiting_client' AND name = 'Awaiting Client';
