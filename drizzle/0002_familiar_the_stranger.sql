CREATE TYPE "public"."document_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."kin_relation" AS ENUM('mother', 'father', 'brother', 'sister', 'wife', 'son', 'daughter');--> statement-breakpoint
CREATE TYPE "public"."merchant_document_type" AS ENUM('owner_cnic_front', 'owner_cnic_back', 'next_of_kin_cnic_front', 'next_of_kin_cnic_back', 'utility_bill', 'company_ntn', 'authority_letter', 'taxpayer_registration_certificate', 'company_incorporation_certificate', 'memorandum_articles', 'form_ii', 'form_a', 'board_resolution', 'certificate_of_commencement', 'partnership_deed', 'form_c', 'llp_form_iii', 'annual_audited_accounts', 'other_entity_certification', 'secp_section_42_license', 'risk_assessment_documents', 'by_laws_rules_regulations');--> statement-breakpoint
CREATE TYPE "public"."merchant_status" AS ENUM('form_submitted', 'documents_review', 'sub_merchant', 'agreement', 'testing', 'live', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."merchant_type" AS ENUM('sole_proprietorship', 'private_limited_company', 'partnership', 'limited_liability_partnership', 'ngo_npo_charity', 'trust_society_association');--> statement-breakpoint
CREATE TYPE "public"."website_cms" AS ENUM('wordpress', 'shopify', 'custom_website');--> statement-breakpoint
CREATE TABLE "merchant_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"document_type" "merchant_document_type" NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"size_bytes" integer NOT NULL,
	"google_drive_file_id" varchar(255) NOT NULL,
	"google_drive_web_view_link" text NOT NULL,
	"google_drive_download_link" text,
	"google_drive_folder_id" varchar(255) NOT NULL,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submitter_email" varchar(255) NOT NULL,
	"owner_full_name" varchar(160) NOT NULL,
	"owner_phone" varchar(32) NOT NULL,
	"business_name" varchar(200) NOT NULL,
	"business_phone" varchar(32) NOT NULL,
	"business_email" varchar(255) NOT NULL,
	"business_address" text NOT NULL,
	"business_website" text NOT NULL,
	"website_cms" "website_cms" NOT NULL,
	"business_description" text NOT NULL,
	"business_registration_date" date NOT NULL,
	"business_nature" varchar(160) NOT NULL,
	"merchant_type" "merchant_type" NOT NULL,
	"estimated_monthly_transactions" integer NOT NULL,
	"estimated_monthly_volume" numeric(14, 2) NOT NULL,
	"account_title" varchar(200) NOT NULL,
	"bank_name" varchar(160) NOT NULL,
	"branch_name" varchar(160) NOT NULL,
	"account_number_iban" varchar(64) NOT NULL,
	"swift_code" varchar(64),
	"next_of_kin_relation" "kin_relation" NOT NULL,
	"status" "merchant_status" DEFAULT 'form_submitted' NOT NULL,
	"onboarding_stage" "merchant_status" DEFAULT 'form_submitted' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."role_type";--> statement-breakpoint
CREATE TYPE "public"."role_type" AS ENUM('admin', 'supervisor', 'employee');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role_type" SET DATA TYPE "public"."role_type" USING "role_type"::"public"."role_type";--> statement-breakpoint
ALTER TABLE "merchant_documents" ADD CONSTRAINT "merchant_documents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_documents_merchant_id_idx" ON "merchant_documents" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_documents_type_idx" ON "merchant_documents" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "merchants_submitter_email_idx" ON "merchants" USING btree ("submitter_email");--> statement-breakpoint
CREATE INDEX "merchants_business_email_idx" ON "merchants" USING btree ("business_email");--> statement-breakpoint
CREATE INDEX "merchants_business_name_idx" ON "merchants" USING btree ("business_name");--> statement-breakpoint
CREATE INDEX "merchants_status_idx" ON "merchants" USING btree ("status");