CREATE SCHEMA "contracts";
--> statement-breakpoint
CREATE TYPE "contracts"."application_status" AS ENUM('draft', 'pending_approval', 'submitted', 'certified', 'disputed', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "contracts"."contract_side" AS ENUM('receivable', 'payable');--> statement-breakpoint
CREATE TYPE "contracts"."contract_status" AS ENUM('draft', 'active', 'suspended', 'practical_completion', 'defects_liability', 'closed', 'terminated');--> statement-breakpoint
CREATE TYPE "contracts"."valuation_basis" AS ENUM('contract_rates', 'pro_rata', 'star_rate', 'dayworks', 'lump_sum');--> statement-breakpoint
CREATE TYPE "contracts"."variation_status" AS ENUM('identified', 'instructed', 'quoted', 'submitted', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TABLE "contracts"."back_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"reference" varchar(48) NOT NULL,
	"description" text NOT NULL,
	"category" varchar(24) DEFAULT 'other' NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"incurred_on" date NOT NULL,
	"status" varchar(24) DEFAULT 'raised' NOT NULL,
	"notified_on" date,
	"agreed_amount" numeric(18, 2),
	"source_snag_id" uuid,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "back_charge_uq" UNIQUE("contract_id","reference")
);
--> statement-breakpoint
CREATE TABLE "contracts"."contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"project_id" uuid,
	"counterparty_id" uuid,
	"side" "contracts"."contract_side" DEFAULT 'receivable' NOT NULL,
	"name" text NOT NULL,
	"external_reference" varchar(64),
	"status" "contracts"."contract_status" DEFAULT 'draft' NOT NULL,
	"form" varchar(32),
	"currency_code" varchar(3),
	"original_sum" numeric(18, 2) DEFAULT '0' NOT NULL,
	"current_sum" numeric(18, 2) DEFAULT '0' NOT NULL,
	"retention_percent" numeric(6, 3),
	"retention_cap_percent" numeric(6, 3),
	"retention_release_schedule" jsonb DEFAULT '{"practicalCompletion":50,"endOfDlp":50}'::jsonb NOT NULL,
	"payment_term_days" integer,
	"defects_liability_months" integer,
	"notice_period_days" integer,
	"tax_percent" numeric(6, 3),
	"advance_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"advance_recovery_start_percent" numeric(6, 3),
	"advance_recovery_end_percent" numeric(6, 3),
	"ld_per_day" numeric(18, 2),
	"ld_cap_percent" numeric(6, 3),
	"securities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"awarded_on" date,
	"commenced_on" date,
	"contract_completion_date" date,
	"practical_completion_on" date,
	"defects_liability_ends_on" date,
	"source_tender_id" uuid,
	"source_estimate_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "contracts"."contract_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"reference" varchar(32),
	"section_name" text,
	"description" text NOT NULL,
	"quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"uom_code" varchar(16),
	"unit_rate" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"kind" varchar(24) DEFAULT 'measured' NOT NULL,
	"source_estimate_line_id" uuid,
	"wbs_node_id" uuid,
	"quantity_certified" numeric(18, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_line_uq" UNIQUE("contract_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "contracts"."correspondence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"type" varchar(24) NOT NULL,
	"reference" varchar(64) NOT NULL,
	"subject" text NOT NULL,
	"direction" varchar(16) DEFAULT 'outgoing' NOT NULL,
	"issued_on" date NOT NULL,
	"response_due_on" date,
	"responded_on" date,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"variation_id" uuid,
	"document_id" uuid,
	"is_contractual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "correspondence_uq" UNIQUE("contract_id","type","reference")
);
--> statement-breakpoint
CREATE TABLE "contracts"."payment_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"sequence" integer NOT NULL,
	"status" "contracts"."application_status" DEFAULT 'draft' NOT NULL,
	"period_from" date,
	"period_to" date NOT NULL,
	"contract_sum_at_valuation" numeric(18, 2) DEFAULT '0' NOT NULL,
	"work_done_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"variations_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"materials_on_site" numeric(18, 2) DEFAULT '0' NOT NULL,
	"materials_on_site_percent" numeric(6, 3),
	"gross_valuation_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"retention_held_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"retention_released" numeric(18, 2) DEFAULT '0' NOT NULL,
	"advance_recovered_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"back_charges_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"liquidated_damages_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"net_valuation_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"previously_certified_net" numeric(18, 2) DEFAULT '0' NOT NULL,
	"net_this_application" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total_applied" numeric(18, 2) DEFAULT '0' NOT NULL,
	"certified_net" numeric(18, 2),
	"certified_tax" numeric(18, 2),
	"certified_total" numeric(18, 2),
	"certified_on" date,
	"certificate_reference" varchar(64),
	"disallowed_reason" text,
	"due_on" date,
	"paid_on" date,
	"paid_amount" numeric(18, 2),
	"submitted_on" date,
	"approval_instance_id" uuid,
	"document_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_application_uq" UNIQUE("contract_id","sequence"),
	CONSTRAINT "payment_application_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "contracts"."payment_application_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"contract_line_id" uuid,
	"variation_id" uuid,
	"description" text NOT NULL,
	"uom_code" varchar(16),
	"unit_rate" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_contract" numeric(18, 4),
	"quantity_to_date" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_previous" numeric(18, 4) DEFAULT '0' NOT NULL,
	"value_to_date" numeric(18, 2) DEFAULT '0' NOT NULL,
	"value_this_period" numeric(18, 2) DEFAULT '0' NOT NULL,
	"quantity_certified" numeric(18, 4),
	"value_certified" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts"."retention_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"trigger" varchar(32) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"due_on" date,
	"released_on" date,
	"application_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts"."submittal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"title" text NOT NULL,
	"submittal_type" varchar(24) NOT NULL,
	"spec_section" varchar(32),
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"ball_in_court" varchar(16) DEFAULT 'contractor' NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submittal_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "contracts"."submittal_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"submittal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document_id" uuid,
	"submitted_on" date NOT NULL,
	"due_on" date,
	"reviewed_on" date,
	"decision" varchar(24),
	"review_comments" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submittal_revision_uq" UNIQUE("submittal_id","revision")
);
--> statement-breakpoint
CREATE TABLE "contracts"."variation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"title" text NOT NULL,
	"description" text,
	"status" "contracts"."variation_status" DEFAULT 'identified' NOT NULL,
	"basis" "contracts"."valuation_basis" DEFAULT 'contract_rates' NOT NULL,
	"instruction_reference" varchar(64),
	"instructed_on" date,
	"instructed_by" text,
	"instruction_document_id" uuid,
	"notice_given_on" date,
	"notice_reference" varchar(64),
	"quoted_value" numeric(18, 2),
	"quoted_cost" numeric(18, 2),
	"submitted_on" date,
	"approved_value" numeric(18, 2),
	"approved_on" date,
	"approved_reference" varchar(64),
	"rejected_reason" text,
	"percent_executed" numeric(6, 3) DEFAULT '0' NOT NULL,
	"eot_claimed_days" integer,
	"eot_granted_days" integer,
	"dayworks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ohp_percent" numeric(6, 3),
	"approval_instance_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variation_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "contracts"."variation_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variation_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"uom_code" varchar(16),
	"unit_rate" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(18, 4),
	"line_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"source_contract_line_id" uuid,
	"wbs_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variation_line_uq" UNIQUE("variation_id","line_number")
);
--> statement-breakpoint
ALTER TABLE "contracts"."back_charge" ADD CONSTRAINT "back_charge_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"."contract"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."contract_line" ADD CONSTRAINT "contract_line_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"."contract"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."correspondence" ADD CONSTRAINT "correspondence_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"."contract"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."correspondence" ADD CONSTRAINT "correspondence_variation_id_variation_id_fk" FOREIGN KEY ("variation_id") REFERENCES "contracts"."variation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."payment_application" ADD CONSTRAINT "payment_application_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"."contract"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."payment_application_line" ADD CONSTRAINT "payment_application_line_application_id_payment_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "contracts"."payment_application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."payment_application_line" ADD CONSTRAINT "payment_application_line_contract_line_id_contract_line_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "contracts"."contract_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."payment_application_line" ADD CONSTRAINT "payment_application_line_variation_id_variation_id_fk" FOREIGN KEY ("variation_id") REFERENCES "contracts"."variation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."retention_release" ADD CONSTRAINT "retention_release_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"."contract"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."retention_release" ADD CONSTRAINT "retention_release_application_id_payment_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "contracts"."payment_application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."submittal" ADD CONSTRAINT "submittal_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"."contract"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."submittal_revision" ADD CONSTRAINT "submittal_revision_submittal_id_submittal_id_fk" FOREIGN KEY ("submittal_id") REFERENCES "contracts"."submittal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."variation" ADD CONSTRAINT "variation_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "contracts"."contract"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."variation_line" ADD CONSTRAINT "variation_line_variation_id_variation_id_fk" FOREIGN KEY ("variation_id") REFERENCES "contracts"."variation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts"."variation_line" ADD CONSTRAINT "variation_line_source_contract_line_id_contract_line_id_fk" FOREIGN KEY ("source_contract_line_id") REFERENCES "contracts"."contract_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "back_charge_status_idx" ON "contracts"."back_charge" USING btree ("tenant_id","contract_id","status");--> statement-breakpoint
CREATE INDEX "contract_project_idx" ON "contracts"."contract" USING btree ("tenant_id","project_id","side");--> statement-breakpoint
CREATE INDEX "contract_status_idx" ON "contracts"."contract" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "contract_line_wbs_idx" ON "contracts"."contract_line" USING btree ("tenant_id","wbs_node_id");--> statement-breakpoint
CREATE INDEX "correspondence_due_idx" ON "contracts"."correspondence" USING btree ("tenant_id","status","response_due_on");--> statement-breakpoint
CREATE INDEX "payment_application_status_idx" ON "contracts"."payment_application" USING btree ("tenant_id","status","due_on");--> statement-breakpoint
CREATE INDEX "payment_application_line_idx" ON "contracts"."payment_application_line" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "payment_application_line_contract_idx" ON "contracts"."payment_application_line" USING btree ("tenant_id","contract_line_id");--> statement-breakpoint
CREATE INDEX "retention_release_idx" ON "contracts"."retention_release" USING btree ("tenant_id","contract_id","due_on");--> statement-breakpoint
CREATE INDEX "submittal_status_idx" ON "contracts"."submittal" USING btree ("tenant_id","status","ball_in_court");--> statement-breakpoint
CREATE INDEX "variation_contract_idx" ON "contracts"."variation" USING btree ("tenant_id","contract_id","status");--> statement-breakpoint
CREATE INDEX "variation_instructed_idx" ON "contracts"."variation" USING btree ("tenant_id","instructed_on");