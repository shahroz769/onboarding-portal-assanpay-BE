ALTER TYPE "public"."role_type" RENAME VALUE 'admin' TO 'super_admin';--> statement-breakpoint
ALTER TYPE "public"."role_type" RENAME VALUE 'supervisor' TO 'admin';
