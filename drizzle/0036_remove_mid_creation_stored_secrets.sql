UPDATE "case_history"
SET "details" = "details" - 'password' - 'portalMuid'
WHERE "action" = 'mid_creation_saved'
  AND "details" IS NOT NULL
  AND ("details" ? 'password' OR "details" ? 'portalMuid');
