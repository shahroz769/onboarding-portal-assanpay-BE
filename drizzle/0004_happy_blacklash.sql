ALTER TABLE "merchants" ALTER COLUMN "priority" SET DATA TYPE text;--> statement-breakpoint
UPDATE "merchants"
SET "priority" = CASE
  WHEN "priority" = 'high' THEN 'high'
  ELSE 'normal'
END;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "priority" SET DEFAULT 'normal'::text;--> statement-breakpoint
DROP TYPE "public"."priority";--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('normal', 'high');--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "priority" SET DEFAULT 'normal'::"public"."priority";--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "priority" SET DATA TYPE "public"."priority" USING "priority"::"public"."priority";
