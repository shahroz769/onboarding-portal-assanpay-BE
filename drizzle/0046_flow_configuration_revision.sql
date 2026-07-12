CREATE TABLE "flow_configuration_revisions" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_configuration_revisions_singleton" CHECK ("id" = 1),
  CONSTRAINT "flow_configuration_revisions_revision_positive" CHECK ("revision" >= 1)
);
--> statement-breakpoint

INSERT INTO "flow_configuration_revisions" ("id", "revision")
VALUES (1, 1);
--> statement-breakpoint

DROP INDEX IF EXISTS "case_flow_start_rules_target_queue_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX "case_flow_start_rules_target_queue_unique"
  ON "case_flow_start_rules" ("target_queue_id")
  WHERE "is_active" = true;
--> statement-breakpoint

DROP INDEX IF EXISTS "case_flow_close_triggers_source_target_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX "case_flow_close_triggers_source_target_unique"
  ON "case_flow_close_triggers" ("source_queue_id", "target_queue_id")
  WHERE "is_active" = true;
--> statement-breakpoint

DROP INDEX IF EXISTS "case_flow_close_blockers_blocked_prerequisite_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX "case_flow_close_blockers_blocked_prerequisite_unique"
  ON "case_flow_close_blockers" ("blocked_queue_id", "prerequisite_queue_id")
  WHERE "is_active" = true;
--> statement-breakpoint

DROP INDEX IF EXISTS "case_flow_creation_requirements_target_prerequisite_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX "case_flow_creation_requirements_target_prerequisite_unique"
  ON "case_flow_creation_requirements" ("target_queue_id", "prerequisite_queue_id")
  WHERE "is_active" = true;
