CREATE TABLE IF NOT EXISTS "case_flow_creation_requirements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_queue_id" uuid NOT NULL,
  "prerequisite_queue_id" uuid NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "case_flow_creation_requirements"
    ADD CONSTRAINT "case_flow_creation_requirements_target_queue_id_queues_id_fk"
    FOREIGN KEY ("target_queue_id") REFERENCES "public"."queues"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "case_flow_creation_requirements"
    ADD CONSTRAINT "case_flow_creation_requirements_prerequisite_queue_id_queues_id_fk"
    FOREIGN KEY ("prerequisite_queue_id") REFERENCES "public"."queues"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "case_flow_creation_requirements_target_prerequisite_unique"
ON "case_flow_creation_requirements" USING btree ("target_queue_id", "prerequisite_queue_id");

CREATE INDEX IF NOT EXISTS "case_flow_creation_requirements_target_idx"
ON "case_flow_creation_requirements" USING btree ("target_queue_id");