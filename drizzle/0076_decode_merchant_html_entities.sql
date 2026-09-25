-- Decode HTML entities previously stored by input escaping. &amp; is decoded last
-- so a literal "&lt;" typed by a merchant (stored as &amp;lt;) round-trips correctly.
UPDATE merchants SET
  owner_full_name = replace(replace(replace(replace(replace(owner_full_name, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
  business_name = replace(replace(replace(replace(replace(business_name, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
  business_address = replace(replace(replace(replace(replace(business_address, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
  business_description = replace(replace(replace(replace(replace(business_description, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
  business_nature = replace(replace(replace(replace(replace(business_nature, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
  account_title = replace(replace(replace(replace(replace(account_title, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
  branch_name = replace(replace(replace(replace(replace(branch_name, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
WHERE
  owner_full_name ~ '&(amp|lt|gt|quot|#39);' OR
  business_name ~ '&(amp|lt|gt|quot|#39);' OR
  business_address ~ '&(amp|lt|gt|quot|#39);' OR
  business_description ~ '&(amp|lt|gt|quot|#39);' OR
  business_nature ~ '&(amp|lt|gt|quot|#39);' OR
  account_title ~ '&(amp|lt|gt|quot|#39);' OR
  branch_name ~ '&(amp|lt|gt|quot|#39);';
