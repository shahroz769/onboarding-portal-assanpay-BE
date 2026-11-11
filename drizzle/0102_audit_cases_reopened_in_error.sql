-- Audit notes for the two production cases a leftover resubmission link
-- reopened after they were closed (fixed in the resubmission token checks and
-- guarded by migration 0101). Both cases and everything they started are kept;
-- this only records what happened. Matched on id and case number so it never
-- touches another environment's cases, and skipped if already recorded.
INSERT INTO "case_history" ("case_id", "actor_id", "action", "details")
SELECT note."case_id", NULL, 'case_reopened_in_error', jsonb_build_object(
  'reason', note."reason",
  'source', 'migration_0102'
)
FROM (VALUES
  (
    '550c006c-3f59-4c99-92ac-9eb29f9be58d'::uuid,
    'DR-000000081',
    'Closed unsuccessfully on 15 Sep 2026, then reopened on 23 Sep 2026 when the merchant used an old resubmission link (a bug, now fixed). The resubmitted NTN Certificate was reviewed and the case was closed successfully on 29 Oct 2026, so its follow-on cases stand.'
  ),
  (
    'cc905f72-85aa-4ee9-85cb-b523f0dbf262'::uuid,
    'DR-000000093',
    'Closed unsuccessfully on 18 Sep 2026, then reopened 36 seconds later when the merchant submitted an old resubmission link (a bug, now fixed). It was closed again by the merchant''s termination on 27 Oct 2026.'
  )
) AS note("case_id", "case_number", "reason")
JOIN "cases" c ON c."id" = note."case_id" AND c."case_number" = note."case_number"
WHERE NOT EXISTS (
  SELECT 1 FROM "case_history" h
  WHERE h."case_id" = note."case_id" AND h."action" = 'case_reopened_in_error'
);
