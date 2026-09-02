-- Retire merchant-triggered Go-Live links that may exist in previously sent emails.
UPDATE "mid_go_live_tokens"
SET "consumed_at" = now()
WHERE "consumed_at" IS NULL;
--> statement-breakpoint

-- A successfully closed Agreement case is the sole automatic source of a Live case.
DELETE FROM "case_flow_start_rules" start_rule
USING "queues" target_queue
WHERE start_rule."target_queue_id" = target_queue."id"
  AND target_queue."workflow_type" = 'live';
--> statement-breakpoint

DELETE FROM "case_flow_close_triggers" close_trigger
USING "queues" source_queue, "queues" target_queue
WHERE close_trigger."source_queue_id" = source_queue."id"
  AND close_trigger."target_queue_id" = target_queue."id"
  AND target_queue."workflow_type" = 'live'
  AND source_queue."workflow_type" <> 'agreement';
--> statement-breakpoint

-- Remove disabled copies of the canonical trigger before ensuring one active copy.
DELETE FROM "case_flow_close_triggers" close_trigger
USING "queues" source_queue, "queues" target_queue
WHERE close_trigger."source_queue_id" = source_queue."id"
  AND close_trigger."target_queue_id" = target_queue."id"
  AND source_queue."workflow_type" = 'agreement'
  AND target_queue."workflow_type" = 'live'
  AND close_trigger."is_active" = false;
--> statement-breakpoint

INSERT INTO "case_flow_close_triggers" (
  "source_queue_id",
  "target_queue_id",
  "order",
  "is_active"
)
SELECT agreement_queue."id", live_queue."id", 1, true
FROM "queues" agreement_queue
CROSS JOIN "queues" live_queue
WHERE agreement_queue."workflow_type" = 'agreement'
  AND live_queue."workflow_type" = 'live'
  AND NOT EXISTS (
    SELECT 1
    FROM "case_flow_close_triggers" existing_trigger
    WHERE existing_trigger."source_queue_id" = agreement_queue."id"
      AND existing_trigger."target_queue_id" = live_queue."id"
      AND existing_trigger."is_active" = true
  );
--> statement-breakpoint

-- Agreement -> Live is represented by the close trigger above. Remove the old,
-- redundant "required first" edge so deleted/inactive copies do not reappear.
DELETE FROM "case_flow_creation_requirements" creation_requirement
USING "queues" target_queue, "queues" prerequisite_queue
WHERE creation_requirement."target_queue_id" = target_queue."id"
  AND creation_requirement."prerequisite_queue_id" = prerequisite_queue."id"
  AND target_queue."workflow_type" = 'live'
  AND prerequisite_queue."workflow_type" = 'agreement';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "prevent_duplicate_live_case"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_is_live boolean;
BEGIN
  SELECT queue."workflow_type" = 'live'
  INTO target_is_live
  FROM "queues" queue
  WHERE queue."id" = NEW."queue_id";

  IF COALESCE(target_is_live, false) THEN
    PERFORM pg_advisory_xact_lock(
      hashtext(NEW."merchant_id"::text),
      hashtext('live-case')
    );

    IF EXISTS (
      SELECT 1
      FROM "cases" existing_case
      INNER JOIN "queues" existing_queue
        ON existing_queue."id" = existing_case."queue_id"
      WHERE existing_case."merchant_id" = NEW."merchant_id"
        AND existing_queue."workflow_type" = 'live'
        AND existing_case."id" IS DISTINCT FROM NEW."id"
    ) THEN
      RAISE EXCEPTION 'A Live case already exists for this merchant.'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "cases_prevent_duplicate_live_case" ON "cases";
--> statement-breakpoint

CREATE TRIGGER "cases_prevent_duplicate_live_case"
BEFORE INSERT OR UPDATE OF "merchant_id", "queue_id" ON "cases"
FOR EACH ROW
EXECUTE FUNCTION "prevent_duplicate_live_case"();
