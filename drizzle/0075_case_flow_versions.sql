-- Cutover migration: run with API mutations and workers paused. Existing rows
-- receive a snapshot of CURRENT rules; overwritten historical rules cannot be recovered.
LOCK TABLE flow_configuration_revisions, merchants, cases, case_flow_close_jobs,
  case_flow_start_rules, case_flow_close_triggers, case_flow_close_blockers,
  case_flow_creation_requirements, queues, queue_stages IN ACCESS EXCLUSIVE MODE;
CREATE TABLE case_flow_versions (
  id serial PRIMARY KEY,
  published_at timestamptz,
  published_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  change_note text,
  queue_snapshot jsonb NOT NULL
);
CREATE INDEX case_flow_versions_published_by_idx ON case_flow_versions(published_by);
INSERT INTO case_flow_versions(id, published_at, change_note, queue_snapshot)
SELECT 1, now(), 'Baseline at versioning cutover; current rules preserved.',
  coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'name', name, 'slug', slug, 'prefix', prefix,
    'workflowType', workflow_type, 'lifecycle', lifecycle, 'isActive', is_active
  ) ORDER BY name), '[]'::jsonb) FROM queues;
SELECT setval('case_flow_versions_id_seq', 1);
ALTER TABLE flow_configuration_revisions ADD COLUMN active_flow_version_id integer
  NOT NULL DEFAULT 1 REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE flow_configuration_revisions ALTER COLUMN active_flow_version_id DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE case_flow_start_rules ADD COLUMN flow_version_id integer NOT NULL DEFAULT 1
  REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_flow_start_rules ALTER COLUMN flow_version_id DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE case_flow_close_triggers ADD COLUMN flow_version_id integer NOT NULL DEFAULT 1
  REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_flow_close_triggers ALTER COLUMN flow_version_id DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE case_flow_close_blockers ADD COLUMN flow_version_id integer NOT NULL DEFAULT 1
  REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_flow_close_blockers ALTER COLUMN flow_version_id DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE case_flow_creation_requirements ADD COLUMN flow_version_id integer NOT NULL DEFAULT 1
  REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_flow_creation_requirements ALTER COLUMN flow_version_id DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE merchants ADD COLUMN flow_version_id integer NOT NULL DEFAULT 1
  REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE merchants ALTER COLUMN flow_version_id DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE cases ADD COLUMN flow_version_id integer NOT NULL DEFAULT 1
  REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE cases ALTER COLUMN flow_version_id DROP DEFAULT;
--> statement-breakpoint

ALTER TABLE case_flow_close_jobs ADD COLUMN flow_version_id integer NOT NULL DEFAULT 1
  REFERENCES case_flow_versions(id) ON DELETE RESTRICT;
ALTER TABLE case_flow_close_jobs ALTER COLUMN flow_version_id DROP DEFAULT;
--> statement-breakpoint

CREATE INDEX merchants_flow_version_idx ON merchants(flow_version_id);
--> statement-breakpoint

CREATE INDEX cases_flow_version_idx ON cases(flow_version_id);
--> statement-breakpoint

CREATE INDEX case_flow_close_jobs_flow_version_idx ON case_flow_close_jobs(flow_version_id);
--> statement-breakpoint

DROP INDEX case_flow_start_rules_target_queue_unique;
CREATE UNIQUE INDEX case_flow_start_rules_target_queue_unique ON case_flow_start_rules(flow_version_id, target_queue_id) WHERE is_active = true;
--> statement-breakpoint

DROP INDEX case_flow_close_triggers_source_target_unique;
CREATE UNIQUE INDEX case_flow_close_triggers_source_target_unique ON case_flow_close_triggers(flow_version_id, source_queue_id, target_queue_id) WHERE is_active = true;
--> statement-breakpoint

DROP INDEX case_flow_close_blockers_blocked_prerequisite_unique;
CREATE UNIQUE INDEX case_flow_close_blockers_blocked_prerequisite_unique ON case_flow_close_blockers(flow_version_id, blocked_queue_id, prerequisite_queue_id) WHERE is_active = true;
--> statement-breakpoint

DROP INDEX case_flow_creation_requirements_target_prerequisite_unique;
CREATE UNIQUE INDEX case_flow_creation_requirements_target_prerequisite_unique ON case_flow_creation_requirements(flow_version_id, target_queue_id, prerequisite_queue_id) WHERE is_active = true;
--> statement-breakpoint

DROP INDEX case_flow_start_rules_order_idx;
CREATE INDEX case_flow_start_rules_order_idx ON case_flow_start_rules(flow_version_id, "order");
DROP INDEX case_flow_close_triggers_source_order_idx;
CREATE INDEX case_flow_close_triggers_source_order_idx ON case_flow_close_triggers(flow_version_id, source_queue_id, "order");
CREATE INDEX case_flow_close_blockers_version_idx ON case_flow_close_blockers(flow_version_id);
CREATE INDEX case_flow_creation_requirements_version_idx ON case_flow_creation_requirements(flow_version_id);
-- Published rules must survive queue deletion attempts, including inactive rules.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype = 'f' AND confrelid = 'queues'::regclass
    AND conrelid IN ('case_flow_start_rules'::regclass, 'case_flow_close_triggers'::regclass,
      'case_flow_close_blockers'::regclass, 'case_flow_creation_requirements'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', c.tbl, c.conname,
      replace(c.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'));
  END LOOP;
END $$;
--> statement-breakpoint

CREATE FUNCTION active_case_flow_version() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  -- Publication takes FOR UPDATE on the same row. Assignment and publication
  -- have one deterministic boundary, held until submission commits.
  SELECT active_flow_version_id INTO v FROM flow_configuration_revisions WHERE id = 1 FOR SHARE;
  IF v IS NULL THEN RAISE EXCEPTION 'Case flow versioning is not initialized'; END IF;
  RETURN v;
END $$;
ALTER TABLE merchants ALTER COLUMN flow_version_id SET DEFAULT active_case_flow_version();
CREATE FUNCTION pin_merchant_case_flow_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v := active_case_flow_version();
    IF NEW.flow_version_id IS NOT NULL AND NEW.flow_version_id <> v THEN
      RAISE EXCEPTION 'New submissions must use the current flow version';
    END IF;
    NEW.flow_version_id := v;
  ELSIF NEW.flow_version_id IS DISTINCT FROM OLD.flow_version_id THEN
    RAISE EXCEPTION 'Merchant flow version cannot be reassigned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER merchants_pin_flow_version BEFORE INSERT OR UPDATE ON merchants
FOR EACH ROW EXECUTE FUNCTION pin_merchant_case_flow_version();
--> statement-breakpoint

CREATE FUNCTION inherit_case_flow_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v integer; source_merchant uuid; source_version integer;
BEGIN
  SELECT flow_version_id INTO v FROM merchants WHERE id = NEW.merchant_id;
  IF v IS NULL THEN RAISE EXCEPTION 'Merchant has no assigned flow version'; END IF;
  IF NEW.flow_version_id IS NOT NULL AND NEW.flow_version_id <> v THEN
    RAISE EXCEPTION 'Flow version must match the merchant';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.flow_version_id <> v OR OLD.merchant_id <> NEW.merchant_id) THEN
    RAISE EXCEPTION 'Flow assignment cannot be changed';
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
CREATE TRIGGER cases_inherit_flow_version BEFORE INSERT OR UPDATE ON cases
FOR EACH ROW EXECUTE FUNCTION inherit_case_flow_version();
CREATE TRIGGER case_flow_jobs_inherit_version BEFORE INSERT OR UPDATE ON case_flow_close_jobs
FOR EACH ROW EXECUTE FUNCTION inherit_case_flow_version();
--> statement-breakpoint

CREATE FUNCTION protect_published_case_flow_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN RAISE EXCEPTION 'Published flow versions are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_flow_versions_immutable BEFORE UPDATE OR DELETE ON case_flow_versions
FOR EACH ROW EXECUTE FUNCTION protect_published_case_flow_version();
CREATE FUNCTION protect_published_case_flow_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v integer; published timestamptz;
BEGIN
  v := CASE WHEN TG_OP = 'DELETE' THEN OLD.flow_version_id ELSE NEW.flow_version_id END;
  IF TG_OP = 'UPDATE' AND NEW.flow_version_id <> OLD.flow_version_id THEN
    RAISE EXCEPTION 'A flow rule cannot move between versions';
  END IF;
  SELECT published_at INTO published FROM case_flow_versions WHERE id = v FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Flow version does not exist'; END IF;
  IF published IS NOT NULL THEN RAISE EXCEPTION 'Published flow rules are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER case_flow_start_rules_immutable BEFORE INSERT OR UPDATE OR DELETE ON case_flow_start_rules
FOR EACH ROW EXECUTE FUNCTION protect_published_case_flow_rule();
--> statement-breakpoint

CREATE TRIGGER case_flow_close_triggers_immutable BEFORE INSERT OR UPDATE OR DELETE ON case_flow_close_triggers
FOR EACH ROW EXECUTE FUNCTION protect_published_case_flow_rule();
--> statement-breakpoint

CREATE TRIGGER case_flow_close_blockers_immutable BEFORE INSERT OR UPDATE OR DELETE ON case_flow_close_blockers
FOR EACH ROW EXECUTE FUNCTION protect_published_case_flow_rule();
--> statement-breakpoint

CREATE TRIGGER case_flow_creation_requirements_immutable BEFORE INSERT OR UPDATE OR DELETE ON case_flow_creation_requirements
FOR EACH ROW EXECUTE FUNCTION protect_published_case_flow_rule();
--> statement-breakpoint

CREATE FUNCTION validate_active_case_flow_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM case_flow_versions WHERE id = NEW.active_flow_version_id AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Active flow must be a published version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER flow_configuration_validate_version BEFORE INSERT OR UPDATE ON flow_configuration_revisions
FOR EACH ROW EXECUTE FUNCTION validate_active_case_flow_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "enqueue_case_flow_jobs_after_successful_close"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  should_enqueue boolean := false;
BEGIN
  IF NEW."status" = 'closed' AND NEW."close_outcome" = 'successful' THEN
    IF TG_OP = 'INSERT' THEN
      should_enqueue := true;
    ELSIF OLD."status" IS DISTINCT FROM NEW."status"
      OR OLD."close_outcome" IS DISTINCT FROM NEW."close_outcome"
    THEN
      should_enqueue := true;
    END IF;
  END IF;

  IF should_enqueue THEN
    INSERT INTO "case_flow_close_jobs" (
      "flow_version_id",
      "source_case_id",
      "merchant_id",
      "source_queue_id",
      "target_queue_id",
      "only_if_target_missing"
    )
    SELECT
      NEW."flow_version_id",
      NEW."id",
      NEW."merchant_id",
      NEW."queue_id",
      close_trigger."target_queue_id",
      true
    FROM "case_flow_close_triggers" close_trigger
    WHERE close_trigger."source_queue_id" = NEW."queue_id"
      AND close_trigger."is_active" = true
      AND close_trigger."flow_version_id" = NEW."flow_version_id"
      AND NOT EXISTS (
        SELECT 1
        FROM "case_flow_close_jobs" completed_job
        WHERE completed_job."merchant_id" = NEW."merchant_id"
          AND completed_job."target_queue_id" = close_trigger."target_queue_id"
          AND completed_job."completed_at" IS NOT NULL
      )
    ON CONFLICT ("source_case_id", "target_queue_id") DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

--> statement-breakpoint

-- Queue definitions are shared. Keep the definitions needed by current and
-- unfinished flows executable; incompatible replacements need a new queue.
CREATE FUNCTION queue_is_needed_by_case_flow(queue uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE active_version integer;
BEGIN
  active_version := active_case_flow_version();
  RETURN EXISTS (
    SELECT 1 FROM (
      SELECT flow_version_id FROM case_flow_start_rules WHERE is_active AND target_queue_id = queue
      UNION SELECT flow_version_id FROM case_flow_close_triggers WHERE is_active AND (source_queue_id = queue OR target_queue_id = queue)
      UNION SELECT flow_version_id FROM case_flow_close_blockers WHERE is_active AND (blocked_queue_id = queue OR prerequisite_queue_id = queue)
      UNION SELECT flow_version_id FROM case_flow_creation_requirements WHERE is_active AND (target_queue_id = queue OR prerequisite_queue_id = queue)
    ) refs JOIN case_flow_versions v ON v.id = refs.flow_version_id
    WHERE v.published_at IS NOT NULL AND (
      v.id = active_version
      OR EXISTS (SELECT 1 FROM merchants m WHERE m.flow_version_id = v.id AND m.deleted_at IS NULL AND m.status IN ('pending', 'testing'))
      OR EXISTS (SELECT 1 FROM cases c WHERE c.flow_version_id = v.id AND c.status <> 'closed')
      OR EXISTS (SELECT 1 FROM case_flow_close_jobs j WHERE j.flow_version_id = v.id AND j.completed_at IS NULL)
    )
  );
END $$;
CREATE FUNCTION protect_case_flow_queue_definition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE queue uuid; changed boolean;
BEGIN
  IF TG_TABLE_NAME = 'queues' THEN
    queue := OLD.id;
    changed := TG_OP = 'DELETE';
    IF TG_OP = 'UPDATE' THEN
      changed := ROW(OLD.lifecycle, OLD.is_active, OLD.workflow_type, OLD.qc_enabled, OLD.slug)
        IS DISTINCT FROM ROW(NEW.lifecycle, NEW.is_active, NEW.workflow_type, NEW.qc_enabled, NEW.slug);
    END IF;
  ELSE
    queue := CASE WHEN TG_OP = 'INSERT' THEN NEW.queue_id ELSE OLD.queue_id END;
    changed := true;
    IF TG_OP = 'UPDATE' THEN
      changed := ROW(OLD.queue_id, OLD.slug, OLD."order", OLD.category, OLD.is_active, OLD.capabilities)
        IS DISTINCT FROM ROW(NEW.queue_id, NEW.slug, NEW."order", NEW.category, NEW.is_active, NEW.capabilities);
    END IF;
  END IF;
  IF changed AND queue_is_needed_by_case_flow(queue) THEN
    RAISE EXCEPTION USING ERRCODE = 'P7501', MESSAGE = 'Queue definition is required by a published flow';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER queues_protect_case_flow BEFORE UPDATE OR DELETE ON queues
FOR EACH ROW EXECUTE FUNCTION protect_case_flow_queue_definition();
CREATE TRIGGER queue_stages_protect_case_flow BEFORE INSERT OR UPDATE OR DELETE ON queue_stages
FOR EACH ROW EXECUTE FUNCTION protect_case_flow_queue_definition();
