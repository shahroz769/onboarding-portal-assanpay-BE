CREATE TABLE IF NOT EXISTS "mid_go_live_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "case_id" uuid NOT NULL,
  "token" varchar(86) NOT NULL,
  "available_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "live_case_id" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mid_go_live_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "mid_go_live_tokens" ADD CONSTRAINT "mid_go_live_tokens_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mid_go_live_tokens" ADD CONSTRAINT "mid_go_live_tokens_live_case_id_cases_id_fk" FOREIGN KEY ("live_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mid_go_live_tokens" ADD CONSTRAINT "mid_go_live_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mid_go_live_tokens_case_id_idx" ON "mid_go_live_tokens" USING btree ("case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mid_go_live_tokens_available_at_idx" ON "mid_go_live_tokens" USING btree ("available_at");
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'New', 'new', 1, 'new', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT (queue_id, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Working', 'working', 2, 'in_progress', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT (queue_id, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO queue_stages (id, queue_id, name, slug, "order", category, created_at)
SELECT gen_random_uuid(), q.id, 'Closed', 'closed', 3, 'closed', now()
FROM queues q WHERE q.slug = 'live'
ON CONFLICT (queue_id, slug) DO NOTHING;
