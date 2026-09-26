-- Seller Codes identify a sub-merchant; reject duplicates regardless of case.
CREATE UNIQUE INDEX IF NOT EXISTS "sub_merchant_draft_templates_seller_code_uniq"
  ON "sub_merchant_draft_templates" (lower("seller_code"));
