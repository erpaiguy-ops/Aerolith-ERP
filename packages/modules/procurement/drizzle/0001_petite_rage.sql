CREATE TYPE "procurement"."supplier_qualification_status" AS ENUM('pending', 'approved', 'suspended');--> statement-breakpoint
CREATE TABLE "procurement"."supplier_qualification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"status" "procurement"."supplier_qualification_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"category_id" uuid,
	"review_date" date,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_qualification_uq" UNIQUE("tenant_id","party_id","category_id")
);
--> statement-breakpoint
CREATE INDEX "supplier_qualification_status_idx" ON "procurement"."supplier_qualification" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "supplier_qualification_party_idx" ON "procurement"."supplier_qualification" USING btree ("tenant_id","party_id");