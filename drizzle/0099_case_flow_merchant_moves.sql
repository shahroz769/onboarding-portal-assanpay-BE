-- Lets an admin move in-progress merchants onto the active case-flow version.
-- A merchant's version still cannot change on its own: the triggers below only
-- accept a change backed by an audit row, so every move has a record of who
-- moved the merchant, why, and which version it came from.
CREATE TABLE case_flow_merchant_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_version_id integer NOT NULL REFERENCES case_flow_versions(id) ON DELETE RESTRICT,
  moved_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  merchant_count integer NOT NULL,
  cancelled_job_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX case_flow_merchant_moves_to_version_idx ON case_flow_merchant_moves(to_version_id);
--> statement-breakpoint

CREATE INDEX case_flow_merchant_moves_moved_by_idx ON case_flow_merchant_moves(moved_by);
--> statement-breakpoint

CREATE TABLE case_flow_merchant_move_items (
  move_id uuid NOT NULL REFERENCES case_flow_merchant_moves(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  from_version_id integer NOT NULL REFERENCES case_flow_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (move_id, merchant_id)
);
--> statement-breakpoint

CREATE INDEX case_flow_merchant_move_items_merchant_from_idx ON case_flow_merchant_move_items(merchant_id, from_version_id);
--> statement-breakpoint

CREATE INDEX case_flow_merchant_move_items_from_version_idx ON case_flow_merchant_move_items(from_version_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pin_merchant_case_flow_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v := active_case_flow_version();
    IF NEW.flow_version_id IS NOT NULL AND NEW.flow_version_id <> v THEN
      RAISE EXCEPTION 'New submissions must use the current flow version';
    END IF;
    NEW.flow_version_id := v;
  ELSIF NEW.flow_version_id IS DISTINCT FROM OLD.flow_version_id THEN
    -- Only a recorded move onto the active version may change the assignment.
    IF NEW.flow_version_id IS DISTINCT FROM active_case_flow_version()
      OR NOT EXISTS (
        SELECT 1
        FROM case_flow_merchant_move_items item
        JOIN case_flow_merchant_moves move ON move.id = item.move_id
        WHERE item.merchant_id = NEW.id
          AND item.from_version_id = OLD.flow_version_id
          AND move.to_version_id = NEW.flow_version_id
      )
    THEN
      RAISE EXCEPTION 'Merchant flow version cannot be reassigned';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION inherit_case_flow_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v integer; source_merchant uuid; source_version integer;
BEGIN
  SELECT flow_version_id INTO v FROM merchants WHERE id = NEW.merchant_id;
  IF v IS NULL THEN RAISE EXCEPTION 'Merchant has no assigned flow version'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.merchant_id <> NEW.merchant_id THEN
      RAISE EXCEPTION 'Flow assignment cannot be changed';
    END IF;
    -- A row behind its merchant is only valid if that merchant was moved away
    -- from the row's version. This covers the move's own re-stamp, and a row
    -- that committed concurrently with a move and so was not re-stamped by it.
    IF OLD.flow_version_id <> v AND NOT EXISTS (
      SELECT 1 FROM case_flow_merchant_move_items item
      WHERE item.merchant_id = NEW.merchant_id
        AND item.from_version_id = OLD.flow_version_id
    ) THEN
      RAISE EXCEPTION 'Flow assignment cannot be changed';
    END IF;
    IF NEW.flow_version_id IS DISTINCT FROM OLD.flow_version_id AND NEW.flow_version_id <> v THEN
      RAISE EXCEPTION 'Flow version must match the merchant';
    END IF;
  ELSIF NEW.flow_version_id IS NOT NULL AND NEW.flow_version_id <> v THEN
    RAISE EXCEPTION 'Flow version must match the merchant';
  END IF;
  IF TG_TABLE_NAME = 'case_flow_close_jobs' THEN
    SELECT merchant_id, flow_version_id INTO source_merchant, source_version
      FROM cases WHERE id = NEW.source_case_id;
    IF source_merchant IS DISTINCT FROM NEW.merchant_id OR source_version IS DISTINCT FROM v THEN
      RAISE EXCEPTION 'Job source must belong to the same merchant and flow version';
    END IF;
  END IF;
  NEW.flow_version_id := v;
  RETURN NEW;
END $$;
