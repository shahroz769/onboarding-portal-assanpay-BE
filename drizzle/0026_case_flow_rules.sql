CREATE TABLE IF NOT EXISTS "case_flow_start_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_queue_id" uuid NOT NULL,
  "order" integer DEFAULT 1 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_flow_close_triggers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_queue_id" uuid NOT NULL,
  "target_queue_id" uuid NOT NULL,
  "order" integer DEFAULT 1 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_flow_close_blockers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "blocked_queue_id" uuid NOT NULL,
  "prerequisite_queue_id" uuid NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "case_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_case_id" uuid,
  "child_case_id" uuid NOT NULL,
  "merchant_id" uuid NOT NULL,
  "trigger_type" varchar(40) NOT NULL,
  "source_queue_id" uuid,
  "target_queue_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_flow_start_rules" ADD CONSTRAINT "case_flow_start_rules_target_queue_id_queues_id_fk" FOREIGN KEY ("target_queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_flow_close_triggers" ADD CONSTRAINT "case_flow_close_triggers_source_queue_id_queues_id_fk" FOREIGN KEY ("source_queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_flow_close_triggers" ADD CONSTRAINT "case_flow_close_triggers_target_queue_id_queues_id_fk" FOREIGN KEY ("target_queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_flow_close_blockers" ADD CONSTRAINT "case_flow_close_blockers_blocked_queue_id_queues_id_fk" FOREIGN KEY ("blocked_queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_flow_close_blockers" ADD CONSTRAINT "case_flow_close_blockers_prerequisite_queue_id_queues_id_fk" FOREIGN KEY ("prerequisite_queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_parent_case_id_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_child_case_id_cases_id_fk" FOREIGN KEY ("child_case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_source_queue_id_queues_id_fk" FOREIGN KEY ("source_queue_id") REFERENCES "public"."queues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_target_queue_id_queues_id_fk" FOREIGN KEY ("target_queue_id") REFERENCES "public"."queues"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_flow_start_rules_target_queue_unique" ON "case_flow_start_rules" USING btree ("target_queue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_flow_start_rules_order_idx" ON "case_flow_start_rules" USING btree ("order");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_flow_close_triggers_source_target_unique" ON "case_flow_close_triggers" USING btree ("source_queue_id","target_queue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_flow_close_triggers_source_order_idx" ON "case_flow_close_triggers" USING btree ("source_queue_id","order");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_flow_close_blockers_blocked_prerequisite_unique" ON "case_flow_close_blockers" USING btree ("blocked_queue_id","prerequisite_queue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_flow_close_blockers_blocked_idx" ON "case_flow_close_blockers" USING btree ("blocked_queue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_links_parent_idx" ON "case_links" USING btree ("parent_case_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "case_links_child_unique" ON "case_links" USING btree ("child_case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_links_merchant_idx" ON "case_links" USING btree ("merchant_id");
