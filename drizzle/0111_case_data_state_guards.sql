-- State rules for four pieces of case data, enforced for every writer. All
-- raise SQLSTATE P7603 (mapped to 409) or a check violation.
--
-- The new checks also validate existing rows. Production was read before
-- this migration was written (2026-11-11): no row breaks them.

-- ─── 1. Document review ─────────────────────────────────────────────────────
-- A merchant document's status follows the latest review of its doc_<id>
-- field on a Documents Review case (modules/cases/document-review-state.ts).
-- Checked at commit for every document or review that changed, so the two
-- rows can be written in either order inside one transaction.
CREATE OR REPLACE FUNCTION "check_document_review_status"(doc_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  document_status text;
  review_status text;
BEGIN
  SELECT d."status"::text INTO document_status
  FROM "merchant_documents" d
  WHERE d."id" = doc_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT r."status"::text INTO review_status
  FROM "case_field_reviews" r
  JOIN "cases" c ON c."id" = r."case_id"
  JOIN "queues" q ON q."id" = c."queue_id"
  WHERE r."field_name" = 'doc_' || doc_id::text
    AND q."workflow_type" = 'document_review'
  ORDER BY greatest(r."updated_at", r."resubmitted_at") DESC
  LIMIT 1;

  IF FOUND AND review_status <> document_status THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P7603',
      MESSAGE = 'document_review_state_violation: status_mismatch',
      DETAIL = format('document %s is %s, its latest review is %s', doc_id, document_status, review_status);
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_document_review_status_from_review"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."field_name" ~* '^doc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM "check_document_review_status"(substring(NEW."field_name" from 5)::uuid);
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_document_review_status_from_document"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "check_document_review_status"(NEW."id");
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "case_field_reviews_document_status" ON "case_field_reviews";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "case_field_reviews_document_status"
AFTER INSERT OR UPDATE OF "status", "updated_at", "resubmitted_at" ON "case_field_reviews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_document_review_status_from_review"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "merchant_documents_review_status" ON "merchant_documents";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "merchant_documents_review_status"
AFTER UPDATE OF "status" ON "merchant_documents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforce_document_review_status_from_document"();--> statement-breakpoint

-- ─── 2. Merchant requests ───────────────────────────────────────────────────
-- A request is resolved once (0108 already ties outcome to resolved_at).
CREATE OR REPLACE FUNCTION "enforce_case_merchant_request_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."resolved_at" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'merchant_request_state_violation: resolved_final';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "case_merchant_requests_enforce_state" ON "case_merchant_requests";--> statement-breakpoint
CREATE TRIGGER "case_merchant_requests_enforce_state"
BEFORE UPDATE OF "resolved_at", "outcome" ON "case_merchant_requests"
FOR EACH ROW
WHEN (
  OLD."resolved_at" IS DISTINCT FROM NEW."resolved_at"
  OR OLD."outcome" IS DISTINCT FROM NEW."outcome"
)
EXECUTE FUNCTION "enforce_case_merchant_request_state"();--> statement-breakpoint

-- ─── 3. Agreement and EP Sub-Merchant Form email send state ─────────────────
-- (modules/cases/case-email-send-state.ts)
--   not_sent  no send time and no email_log row
--   sent      has a send time (email_log row for Resend, none for a manual copy)
--   failed    no send time
ALTER TABLE "agreement_case_details" DROP CONSTRAINT IF EXISTS "agreement_case_details_email_state_check";--> statement-breakpoint
ALTER TABLE "agreement_case_details" ADD CONSTRAINT "agreement_case_details_email_state_check"
  CHECK (
    ("email_status" = 'not_sent' AND "email_sent_at" IS NULL AND "email_log_id" IS NULL)
    OR ("email_status" = 'sent' AND "email_sent_at" IS NOT NULL)
    OR ("email_status" = 'failed' AND "email_sent_at" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "sub_merchant_form_details" DROP CONSTRAINT IF EXISTS "sub_merchant_form_details_email_state_check";--> statement-breakpoint
ALTER TABLE "sub_merchant_form_details" ADD CONSTRAINT "sub_merchant_form_details_email_state_check"
  CHECK (
    ("email_status" = 'not_sent' AND "email_sent_at" IS NULL AND "email_log_id" IS NULL)
    OR ("email_status" = 'sent' AND "email_sent_at" IS NOT NULL)
    OR ("email_status" = 'failed' AND "email_sent_at" IS NULL)
  );--> statement-breakpoint

-- ─── 4. Merchant portal password codes ──────────────────────────────────────
--   active      neither consumed nor superseded; holds its ciphertext
--   used        consumed_at set when the credentials went out; ciphertext gone
--   superseded  replaced by a newer code; ciphertext gone
-- used and superseded are final.
ALTER TABLE "merchant_portal_password_codes" DROP CONSTRAINT IF EXISTS "merchant_portal_password_codes_state_check";--> statement-breakpoint
ALTER TABLE "merchant_portal_password_codes" ADD CONSTRAINT "merchant_portal_password_codes_state_check"
  CHECK (
    NOT ("consumed_at" IS NOT NULL AND "superseded_at" IS NOT NULL)
    AND (("consumed_at" IS NULL AND "superseded_at" IS NULL) = ("code_ciphertext" IS NOT NULL))
  );--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_portal_password_code_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."consumed_at" IS NOT NULL OR OLD."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'portal_password_code_state_violation: closed_final';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "merchant_portal_password_codes_enforce_state" ON "merchant_portal_password_codes";--> statement-breakpoint
CREATE TRIGGER "merchant_portal_password_codes_enforce_state"
BEFORE UPDATE OF "consumed_at", "superseded_at" ON "merchant_portal_password_codes"
FOR EACH ROW
WHEN (
  OLD."consumed_at" IS DISTINCT FROM NEW."consumed_at"
  OR OLD."superseded_at" IS DISTINCT FROM NEW."superseded_at"
)
EXECUTE FUNCTION "enforce_portal_password_code_state"();
