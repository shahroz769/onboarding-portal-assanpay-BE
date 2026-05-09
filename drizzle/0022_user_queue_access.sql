DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'role_type' AND e.enumlabel = 'employee'
  ) THEN
    ALTER TYPE "public"."role_type" RENAME VALUE 'employee' TO 'agent';
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."user_gender" AS ENUM('male', 'female');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."queue_view_scope" AS ENUM('all', 'selected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."user_queue_access_type" AS ENUM('view', 'work');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."password_token_purpose" AS ENUM('invite', 'reset');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'employee_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'username'
  ) THEN
    ALTER TABLE "users" RENAME COLUMN "employee_id" TO "username";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" "user_gender" DEFAULT 'male' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "queue_view_scope" "queue_view_scope" DEFAULT 'all' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_queue_access" (
  "user_id" uuid NOT NULL,
  "queue_id" uuid NOT NULL,
  "access_type" "user_queue_access_type" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_queue_access_pk" PRIMARY KEY("user_id","queue_id","access_type")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_password_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "purpose" "password_token_purpose" NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_password_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_queue_access" ADD CONSTRAINT "user_queue_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_queue_access" ADD CONSTRAINT "user_queue_access_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_password_tokens" ADD CONSTRAINT "user_password_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_password_tokens" ADD CONSTRAINT "user_password_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_queue_access_user_idx" ON "user_queue_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_queue_access_queue_idx" ON "user_queue_access" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_password_tokens_user_idx" ON "user_password_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_password_tokens_token_hash_idx" ON "user_password_tokens" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_access_policy_id_access_policies_id_fk";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "access_policy_id";--> statement-breakpoint
DROP TABLE IF EXISTS "policy_queues";--> statement-breakpoint
DROP TABLE IF EXISTS "access_policies";
