CREATE TYPE "public"."business_scope" AS ENUM('local', 'international');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "merchant_number" serial NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "priority" "priority" DEFAULT 'low' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "priority_note" varchar(500);--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "business_scope" "business_scope" DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "currency" varchar(8) DEFAULT 'PKR' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "live_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "merchants_number_idx" ON "merchants" USING btree ("merchant_number");--> statement-breakpoint
CREATE INDEX "merchants_priority_idx" ON "merchants" USING btree ("priority");--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_merchant_number_unique" UNIQUE("merchant_number");
