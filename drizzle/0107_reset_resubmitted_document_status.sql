-- A merchant's replacement file kept the rejected status of the file it
-- replaced, while its field review went back to pending. Reset those
-- documents to pending: still rejected, with the latest review of the field
-- pending after a resubmission. Rows changed since then are not matched.
UPDATE "merchant_documents" document
SET "status" = 'pending', "updated_at" = now()
WHERE document."status" = 'rejected'
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT review."status", review."resubmitted_at"
      FROM "case_field_reviews" review
      WHERE review."field_name" = 'doc_' || document."id"::text
      ORDER BY review."updated_at" DESC
      LIMIT 1
    ) latest
    WHERE latest."status" = 'pending'
      AND latest."resubmitted_at" IS NOT NULL
  );
