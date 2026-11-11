-- is_active mirrors lifecycle: true exactly when the queue is active. The
-- column default followed the old boolean (true) while lifecycle defaults to
-- inactive, so an insert relying on both defaults would have disagreed.
ALTER TABLE "queues" ALTER COLUMN "is_active" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "queues" DROP CONSTRAINT IF EXISTS "queues_is_active_matches_lifecycle";--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_is_active_matches_lifecycle"
  CHECK ("is_active" = ("lifecycle" = 'active'));--> statement-breakpoint
-- A queue that has been active or inactive never returns to draft. Raises
-- SQLSTATE P7603, which the API maps to 409.
CREATE OR REPLACE FUNCTION "enforce_queue_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."lifecycle" = 'draft' AND OLD."lifecycle" <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = 'P7603', MESSAGE = 'queue_state_violation: back_to_draft';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "queues_enforce_lifecycle" ON "queues";--> statement-breakpoint
CREATE TRIGGER "queues_enforce_lifecycle"
BEFORE UPDATE OF "lifecycle" ON "queues"
FOR EACH ROW
WHEN (OLD."lifecycle" IS DISTINCT FROM NEW."lifecycle")
EXECUTE FUNCTION "enforce_queue_lifecycle"();
