CREATE SCHEMA "projects";
--> statement-breakpoint
CREATE TYPE "projects"."budget_status" AS ENUM('draft', 'pending_approval', 'approved', 'superseded');--> statement-breakpoint
CREATE TYPE "projects"."commitment_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "projects"."cost_category" AS ENUM('material', 'labour', 'machine', 'finishing', 'hardware', 'subcontract', 'transport', 'preliminaries', 'contingency', 'other');--> statement-breakpoint
CREATE TYPE "projects"."milestone_type" AS ENUM('contractual', 'internal');--> statement-breakpoint
CREATE TYPE "projects"."rule_of_credit" AS ENUM('binary', 'started_finished', 'units', 'milestone', 'manual');--> statement-breakpoint
CREATE TYPE "projects"."snag_status" AS ENUM('open', 'in_progress', 'ready_for_inspection', 'closed', 'rejected');--> statement-breakpoint
CREATE TABLE "projects"."budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "projects"."budget_status" DEFAULT 'draft' NOT NULL,
	"source" varchar(24) DEFAULT 'manual' NOT NULL,
	"source_estimate_id" uuid,
	"source_variation_id" uuid,
	"total_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"contingency_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"contingency_drawn" numeric(18, 2) DEFAULT '0' NOT NULL,
	"approval_instance_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_uq" UNIQUE("project_id","version")
);
--> statement-breakpoint
CREATE TABLE "projects"."budget_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"wbs_node_id" uuid,
	"source_estimate_line_id" uuid,
	"item_id" uuid,
	"category" "projects"."cost_category" NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"uom_code" varchar(16),
	"unit_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"line_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects"."commitment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_node_id" uuid,
	"type" varchar(24) NOT NULL,
	"reference" varchar(64) NOT NULL,
	"party_id" uuid,
	"description" text,
	"category" "projects"."cost_category" NOT NULL,
	"committed_amount" numeric(18, 2) NOT NULL,
	"invoiced_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3),
	"status" "projects"."commitment_status" DEFAULT 'open' NOT NULL,
	"source_module" varchar(32) NOT NULL,
	"source_entity_id" uuid,
	"expected_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitment_uq" UNIQUE("tenant_id","source_module","reference")
);
--> statement-breakpoint
CREATE TABLE "projects"."cost_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_node_id" uuid,
	"posted_on" date NOT NULL,
	"category" "projects"."cost_category" NOT NULL,
	"description" text NOT NULL,
	"source_module" varchar(32) NOT NULL,
	"source_entity_type" varchar(64),
	"source_entity_id" uuid,
	"amount" numeric(18, 2) NOT NULL,
	"currency_code" varchar(3),
	"quantity" numeric(18, 4),
	"uom_code" varchar(16),
	"is_accrual" boolean DEFAULT false NOT NULL,
	"reverses_entry_id" uuid,
	"posted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects"."milestone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_node_id" uuid,
	"name" text NOT NULL,
	"type" "projects"."milestone_type" DEFAULT 'internal' NOT NULL,
	"baseline_date" date,
	"forecast_date" date,
	"actual_date" date,
	"liquidated_damages_apply" boolean DEFAULT false NOT NULL,
	"extension_days" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects"."progress_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_node_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"rule_of_credit" "projects"."rule_of_credit" NOT NULL,
	"units_complete" numeric(18, 4),
	"units_planned" numeric(18, 4),
	"started" boolean DEFAULT false NOT NULL,
	"finished" boolean DEFAULT false NOT NULL,
	"milestones_achieved" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manual_percent" numeric(6, 3),
	"percent_complete" numeric(6, 3) NOT NULL,
	"earned_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"evidence_document_id" uuid,
	"measured_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progress_entry_uq" UNIQUE("wbs_node_id","period_end")
);
--> statement-breakpoint
CREATE TABLE "projects"."project_detail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_manager_id" uuid,
	"quantity_surveyor_id" uuid,
	"baseline_start_date" date,
	"baseline_end_date" date,
	"forecast_end_date" date,
	"practical_completion_date" date,
	"defects_liability_ends_on" date,
	"health_status" varchar(16) DEFAULT 'green' NOT NULL,
	"health_note" text,
	"tender_margin_percent" numeric(6, 3),
	"source_tender_id" uuid,
	"source_estimate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_detail_uq" UNIQUE("tenant_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "projects"."snag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_node_id" uuid,
	"reference" varchar(32) NOT NULL,
	"location" text,
	"description" text NOT NULL,
	"severity" varchar(16) DEFAULT 'minor' NOT NULL,
	"status" "projects"."snag_status" DEFAULT 'open' NOT NULL,
	"raised_by" uuid,
	"raised_on" date NOT NULL,
	"assigned_to_user_id" uuid,
	"assigned_to_party_id" uuid,
	"target_date" date,
	"closed_on" date,
	"closed_by" uuid,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"back_charge_amount" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snag_uq" UNIQUE("project_id","reference")
);
--> statement-breakpoint
CREATE TABLE "projects"."wbs_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" varchar(48) NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"rule_of_credit" "projects"."rule_of_credit" DEFAULT 'manual' NOT NULL,
	"units_planned" numeric(18, 4),
	"uom_code" varchar(16),
	"credit_milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"budget_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"percent_complete" numeric(6, 3) DEFAULT '0' NOT NULL,
	"last_measured_on" date,
	"work_order_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wbs_node_uq" UNIQUE("project_id","code")
);
--> statement-breakpoint
ALTER TABLE "projects"."budget_line" ADD CONSTRAINT "budget_line_budget_id_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "projects"."budget"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."budget_line" ADD CONSTRAINT "budget_line_wbs_node_id_wbs_node_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "projects"."wbs_node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."commitment" ADD CONSTRAINT "commitment_wbs_node_id_wbs_node_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "projects"."wbs_node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."cost_entry" ADD CONSTRAINT "cost_entry_wbs_node_id_wbs_node_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "projects"."wbs_node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."milestone" ADD CONSTRAINT "milestone_wbs_node_id_wbs_node_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "projects"."wbs_node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."progress_entry" ADD CONSTRAINT "progress_entry_wbs_node_id_wbs_node_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "projects"."wbs_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."snag" ADD CONSTRAINT "snag_wbs_node_id_wbs_node_id_fk" FOREIGN KEY ("wbs_node_id") REFERENCES "projects"."wbs_node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_status_idx" ON "projects"."budget" USING btree ("tenant_id","project_id","status");--> statement-breakpoint
CREATE INDEX "budget_line_budget_idx" ON "projects"."budget_line" USING btree ("tenant_id","budget_id");--> statement-breakpoint
CREATE INDEX "budget_line_wbs_idx" ON "projects"."budget_line" USING btree ("tenant_id","wbs_node_id");--> statement-breakpoint
CREATE INDEX "commitment_project_idx" ON "projects"."commitment" USING btree ("tenant_id","project_id","status");--> statement-breakpoint
CREATE INDEX "cost_entry_project_idx" ON "projects"."cost_entry" USING btree ("tenant_id","project_id","posted_on");--> statement-breakpoint
CREATE INDEX "cost_entry_wbs_idx" ON "projects"."cost_entry" USING btree ("tenant_id","wbs_node_id","category");--> statement-breakpoint
CREATE INDEX "cost_entry_source_idx" ON "projects"."cost_entry" USING btree ("tenant_id","source_module","source_entity_id");--> statement-breakpoint
CREATE INDEX "milestone_project_idx" ON "projects"."milestone" USING btree ("tenant_id","project_id","forecast_date");--> statement-breakpoint
CREATE INDEX "progress_entry_period_idx" ON "projects"."progress_entry" USING btree ("tenant_id","project_id","period_end");--> statement-breakpoint
CREATE INDEX "snag_status_idx" ON "projects"."snag" USING btree ("tenant_id","project_id","status","severity");--> statement-breakpoint
CREATE INDEX "wbs_node_parent_idx" ON "projects"."wbs_node" USING btree ("tenant_id","project_id","parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "wbs_node_path_idx" ON "projects"."wbs_node" USING btree ("tenant_id","project_id","path");