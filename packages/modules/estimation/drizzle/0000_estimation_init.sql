CREATE SCHEMA "estimation";
--> statement-breakpoint
CREATE TYPE "estimation"."component_type" AS ENUM('material', 'labour', 'machine', 'finishing', 'hardware', 'subcontract', 'transport', 'other');--> statement-breakpoint
CREATE TYPE "estimation"."estimate_status" AS ENUM('draft', 'pending_approval', 'approved', 'superseded');--> statement-breakpoint
CREATE TYPE "estimation"."line_kind" AS ENUM('measured', 'provisional_sum', 'prime_cost', 'dayworks', 'preliminaries', 'optional');--> statement-breakpoint
CREATE TYPE "estimation"."tender_status" AS ENUM('identified', 'prequalifying', 'bid_no_bid', 'estimating', 'submitted', 'clarifying', 'won', 'lost', 'abandoned', 'cancelled');--> statement-breakpoint
CREATE TABLE "estimation"."estimate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tender_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"label" text NOT NULL,
	"status" "estimation"."estimate_status" DEFAULT 'draft' NOT NULL,
	"rate_library_id" uuid,
	"overhead_percent" numeric(6, 3),
	"margin_percent" numeric(6, 3),
	"total_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"provisional_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"optional_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"is_submitted" boolean DEFAULT false NOT NULL,
	"approval_instance_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimate_uq" UNIQUE("tender_id","version")
);
--> statement-breakpoint
CREATE TABLE "estimation"."estimate_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"section_id" uuid,
	"line_number" integer NOT NULL,
	"reference" varchar(32),
	"description" text NOT NULL,
	"quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"uom_code" varchar(16),
	"kind" "estimation"."line_kind" DEFAULT 'measured' NOT NULL,
	"rate_item_id" uuid,
	"unit_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_rate" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"line_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"margin_percent" numeric(6, 3),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimate_line_uq" UNIQUE("estimate_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "estimation"."estimate_line_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" "estimation"."component_type" NOT NULL,
	"description" text,
	"item_id" uuid,
	"quantity_per_unit" numeric(18, 6) NOT NULL,
	"unit_rate" numeric(18, 6) NOT NULL,
	"wastage_percent" numeric(6, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimate_line_component_uq" UNIQUE("line_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "estimation"."estimate_section" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"parent_id" uuid,
	"reference" varchar(32),
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimation"."rate_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rate_item_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" "estimation"."component_type" NOT NULL,
	"description" text,
	"item_id" uuid,
	"quantity_per_unit" numeric(18, 6) NOT NULL,
	"unit_rate" numeric(18, 6) NOT NULL,
	"wastage_percent" numeric(6, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_component_uq" UNIQUE("rate_item_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "estimation"."rate_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"code" varchar(48) NOT NULL,
	"description" text NOT NULL,
	"uom_id" uuid,
	"uom_code" varchar(16),
	"direct_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_rate" numeric(18, 4) DEFAULT '0' NOT NULL,
	"overhead_percent" numeric(6, 3),
	"margin_percent" numeric(6, 3),
	"last_actual_cost" numeric(18, 4),
	"actual_sample_size" integer DEFAULT 0 NOT NULL,
	"last_actual_at" timestamp with time zone,
	"category" varchar(64),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_item_uq" UNIQUE("library_id","code")
);
--> statement-breakpoint
CREATE TABLE "estimation"."rate_library" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"currency_code" varchar(3),
	"is_current" boolean DEFAULT false NOT NULL,
	"effective_from" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_library_uq" UNIQUE("tenant_id","code","version")
);
--> statement-breakpoint
CREATE TABLE "estimation"."tender" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"name" text NOT NULL,
	"status" "estimation"."tender_status" DEFAULT 'identified' NOT NULL,
	"client_party_id" uuid,
	"consultant_party_id" uuid,
	"main_contractor_party_id" uuid,
	"project_id" uuid,
	"site_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"currency_code" varchar(3),
	"submission_due_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"validity_days" integer,
	"bid_decision" varchar(16),
	"bid_decision_reason" text,
	"bid_decided_by" uuid,
	"bid_decided_at" timestamp with time zone,
	"bonds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome_value" numeric(18, 2),
	"lost_to_party_id" uuid,
	"lost_reason" text,
	"winning_value" numeric(18, 2),
	"owner_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tender_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "estimation"."tender_addendum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tender_id" uuid NOT NULL,
	"reference" varchar(64) NOT NULL,
	"issued_on" date,
	"received_on" date,
	"description" text,
	"is_priced" boolean DEFAULT false NOT NULL,
	"price_impact" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tender_addendum_uq" UNIQUE("tender_id","reference")
);
--> statement-breakpoint
ALTER TABLE "estimation"."estimate" ADD CONSTRAINT "estimate_tender_id_tender_id_fk" FOREIGN KEY ("tender_id") REFERENCES "estimation"."tender"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."estimate" ADD CONSTRAINT "estimate_rate_library_id_rate_library_id_fk" FOREIGN KEY ("rate_library_id") REFERENCES "estimation"."rate_library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."estimate_line" ADD CONSTRAINT "estimate_line_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "estimation"."estimate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."estimate_line" ADD CONSTRAINT "estimate_line_section_id_estimate_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "estimation"."estimate_section"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."estimate_line" ADD CONSTRAINT "estimate_line_rate_item_id_rate_item_id_fk" FOREIGN KEY ("rate_item_id") REFERENCES "estimation"."rate_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."estimate_line_component" ADD CONSTRAINT "estimate_line_component_line_id_estimate_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "estimation"."estimate_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."estimate_section" ADD CONSTRAINT "estimate_section_estimate_id_estimate_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "estimation"."estimate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."rate_component" ADD CONSTRAINT "rate_component_rate_item_id_rate_item_id_fk" FOREIGN KEY ("rate_item_id") REFERENCES "estimation"."rate_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."rate_item" ADD CONSTRAINT "rate_item_library_id_rate_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "estimation"."rate_library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimation"."tender_addendum" ADD CONSTRAINT "tender_addendum_tender_id_tender_id_fk" FOREIGN KEY ("tender_id") REFERENCES "estimation"."tender"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimate_status_idx" ON "estimation"."estimate" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "estimate_line_section_idx" ON "estimation"."estimate_line" USING btree ("tenant_id","section_id");--> statement-breakpoint
CREATE INDEX "estimate_section_idx" ON "estimation"."estimate_section" USING btree ("tenant_id","estimate_id","sort_order");--> statement-breakpoint
CREATE INDEX "rate_component_item_idx" ON "estimation"."rate_component" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "rate_item_category_idx" ON "estimation"."rate_item" USING btree ("tenant_id","category","is_active");--> statement-breakpoint
CREATE INDEX "rate_library_current_idx" ON "estimation"."rate_library" USING btree ("tenant_id","is_current");--> statement-breakpoint
CREATE INDEX "tender_status_idx" ON "estimation"."tender" USING btree ("tenant_id","status","submission_due_at");--> statement-breakpoint
CREATE INDEX "tender_client_idx" ON "estimation"."tender" USING btree ("tenant_id","client_party_id");