-- Superseded: Seller Codes may be shared between sub-merchants. The unique
-- index this migration used to create could not be built on production data,
-- so it is now a no-op; 0080 drops the index where it was already applied.
SELECT 1;
