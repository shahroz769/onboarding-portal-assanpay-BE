ALTER TABLE "merchants" ADD COLUMN "active_whatsapp_number" varchar(32);
CREATE INDEX IF NOT EXISTS "merchants_owner_phone_idx" ON "merchants" USING btree ("owner_phone");
CREATE INDEX IF NOT EXISTS "merchants_business_phone_idx" ON "merchants" USING btree ("business_phone");
CREATE INDEX IF NOT EXISTS "merchants_active_whatsapp_number_idx" ON "merchants" USING btree ("active_whatsapp_number");
