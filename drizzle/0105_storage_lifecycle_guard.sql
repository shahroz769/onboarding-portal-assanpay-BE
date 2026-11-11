-- Rejects storage-object lifecycle moves that no application path makes,
-- whoever writes them. Raises SQLSTATE P7603, which the API maps to 409.
--
--   provisioning -> current, failed, deleted
--   current      -> superseded, deleted
--   superseded   -> deleted
--   failed       -> deleted
--   deleted      is final
--
-- In particular a committed (current or superseded) object can never become
-- failed, so failed-attempt cleanup cannot delete a file a document uses.
CREATE OR REPLACE FUNCTION "enforce_storage_object_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    (OLD."lifecycle" = 'provisioning' AND NEW."lifecycle" IN ('current', 'failed', 'deleted'))
    OR (OLD."lifecycle" = 'current' AND NEW."lifecycle" IN ('superseded', 'deleted'))
    OR (OLD."lifecycle" IN ('superseded', 'failed') AND NEW."lifecycle" = 'deleted')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P7603',
      MESSAGE = 'storage_state_violation: ' || OLD."lifecycle" || '_to_' || NEW."lifecycle";
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "storage_objects_enforce_lifecycle" ON "storage_objects";--> statement-breakpoint
CREATE TRIGGER "storage_objects_enforce_lifecycle"
BEFORE UPDATE OF "lifecycle" ON "storage_objects"
FOR EACH ROW
WHEN (OLD."lifecycle" IS DISTINCT FROM NEW."lifecycle")
EXECUTE FUNCTION "enforce_storage_object_lifecycle"();
