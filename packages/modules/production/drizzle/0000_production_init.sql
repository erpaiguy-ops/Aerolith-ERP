CREATE SCHEMA "production";
--> statement-breakpoint
CREATE TYPE "production"."finishing_status" AS ENUM('queued', 'spraying', 'curing', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "production"."operation_status" AS ENUM('pending', 'ready', 'in_progress', 'paused', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "production"."scan_type" AS ENUM('start', 'complete', 'pause', 'resume', 'reject', 'rework');--> statement-breakpoint
CREATE TYPE "production"."work_centre_type" AS ENUM('beam_saw', 'cnc', 'edgebander', 'drilling', 'sanding', 'spray_booth', 'assembly', 'quality', 'packing', 'other');--> statement-breakpoint
CREATE TYPE "production"."work_order_status" AS ENUM('draft', 'planned', 'released', 'in_progress', 'on_hold', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "production"."cutting_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"plan" jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sheets_used" integer DEFAULT 0 NOT NULL,
	"offcuts_used" integer DEFAULT 0 NOT NULL,
	"gross_yield_percent" numeric(6, 2),
	"net_yield_percent" numeric(6, 2),
	"material_cost" numeric(18, 4),
	"consumed_offcut_ids" uuid[] DEFAULT '{}'::uuid[],
	"is_committed" boolean DEFAULT false NOT NULL,
	"committed_at" timestamp with time zone,
	"generated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cutting_plan_uq" UNIQUE("work_order_id","version")
);
--> statement-breakpoint
CREATE TABLE "production"."finishing_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"work_centre_id" uuid NOT NULL,
	"status" "production"."finishing_status" DEFAULT 'queued' NOT NULL,
	"colour_code" varchar(32),
	"sheen_code" varchar(32),
	"coat_number" integer DEFAULT 1 NOT NULL,
	"total_coats" integer DEFAULT 1 NOT NULL,
	"cure_minutes" integer DEFAULT 0 NOT NULL,
	"sprayed_at" timestamp with time zone,
	"cure_completes_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"is_on_hold" boolean DEFAULT false NOT NULL,
	"hold_reason" text,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"operator_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finishing_batch_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "production"."finishing_batch_part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"is_rework" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finishing_batch_part_uq" UNIQUE("batch_id","part_id")
);
--> statement-breakpoint
CREATE TABLE "production"."production_scan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"part_id" uuid,
	"type" "production"."scan_type" NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"operator_id" uuid,
	"work_centre_id" uuid NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_minutes" numeric(10, 2),
	"reason_code" varchar(32),
	"notes" text,
	"is_offline" boolean DEFAULT false NOT NULL,
	"device_id" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "production"."routing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"item_id" uuid,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "production"."routing_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"routing_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"name" text NOT NULL,
	"work_centre_id" uuid NOT NULL,
	"setup_minutes" numeric(8, 2),
	"run_minutes_per_unit" numeric(8, 4),
	"cure_minutes" integer DEFAULT 0 NOT NULL,
	"is_quality_gate" boolean DEFAULT false NOT NULL,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_operation_uq" UNIQUE("routing_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "production"."work_centre" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"type" "production"."work_centre_type" NOT NULL,
	"asset_id" uuid,
	"capacity_units" integer DEFAULT 1 NOT NULL,
	"setup_minutes" numeric(8, 2) DEFAULT '0' NOT NULL,
	"run_minutes_per_unit" numeric(8, 4) DEFAULT '0' NOT NULL,
	"cost_per_hour" numeric(12, 4),
	"working_minutes_per_day" integer DEFAULT 480 NOT NULL,
	"is_batch_process" boolean DEFAULT false NOT NULL,
	"batch_capacity_units" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_centre_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "production"."work_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"project_id" uuid,
	"item_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(18, 4) DEFAULT '1' NOT NULL,
	"routing_id" uuid,
	"status" "production"."work_order_status" DEFAULT 'draft' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"planned_start_date" date,
	"planned_end_date" date,
	"actual_start_at" timestamp with time zone,
	"actual_end_at" timestamp with time zone,
	"source_module" varchar(64),
	"source_entity_type" varchar(96),
	"source_entity_id" uuid,
	"approval_instance_id" uuid,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"hold_reason" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "production"."work_order_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"name" text NOT NULL,
	"work_centre_id" uuid NOT NULL,
	"status" "production"."operation_status" DEFAULT 'pending' NOT NULL,
	"setup_minutes" numeric(8, 2) DEFAULT '0' NOT NULL,
	"run_minutes_per_unit" numeric(8, 4) DEFAULT '0' NOT NULL,
	"cure_minutes" integer DEFAULT 0 NOT NULL,
	"is_quality_gate" boolean DEFAULT false NOT NULL,
	"planned_minutes" numeric(10, 2),
	"actual_minutes" numeric(10, 2) DEFAULT '0' NOT NULL,
	"completed_quantity" integer DEFAULT 0 NOT NULL,
	"rejected_quantity" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_operation_uq" UNIQUE("work_order_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "production"."work_order_part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"label" text NOT NULL,
	"material_item_id" uuid NOT NULL,
	"length_mm" numeric(12, 2) NOT NULL,
	"width_mm" numeric(12, 2) NOT NULL,
	"thickness_mm" numeric(12, 2),
	"quantity" integer DEFAULT 1 NOT NULL,
	"grain_along" varchar(8),
	"edge_banding" jsonb,
	"finish_spec" jsonb,
	"barcode" varchar(64),
	"completed_quantity" integer DEFAULT 0 NOT NULL,
	"rejected_quantity" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_part_uq" UNIQUE("work_order_id","part_number"),
	CONSTRAINT "work_order_part_barcode_uq" UNIQUE("tenant_id","barcode")
);
--> statement-breakpoint
ALTER TABLE "production"."cutting_plan" ADD CONSTRAINT "cutting_plan_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "production"."work_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."finishing_batch" ADD CONSTRAINT "finishing_batch_work_centre_id_work_centre_id_fk" FOREIGN KEY ("work_centre_id") REFERENCES "production"."work_centre"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."finishing_batch_part" ADD CONSTRAINT "finishing_batch_part_batch_id_finishing_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "production"."finishing_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."finishing_batch_part" ADD CONSTRAINT "finishing_batch_part_part_id_work_order_part_id_fk" FOREIGN KEY ("part_id") REFERENCES "production"."work_order_part"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."production_scan" ADD CONSTRAINT "production_scan_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "production"."work_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."production_scan" ADD CONSTRAINT "production_scan_operation_id_work_order_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "production"."work_order_operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."production_scan" ADD CONSTRAINT "production_scan_part_id_work_order_part_id_fk" FOREIGN KEY ("part_id") REFERENCES "production"."work_order_part"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."routing_operation" ADD CONSTRAINT "routing_operation_routing_id_routing_id_fk" FOREIGN KEY ("routing_id") REFERENCES "production"."routing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."routing_operation" ADD CONSTRAINT "routing_operation_work_centre_id_work_centre_id_fk" FOREIGN KEY ("work_centre_id") REFERENCES "production"."work_centre"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."work_order" ADD CONSTRAINT "work_order_routing_id_routing_id_fk" FOREIGN KEY ("routing_id") REFERENCES "production"."routing"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."work_order_operation" ADD CONSTRAINT "work_order_operation_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "production"."work_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."work_order_operation" ADD CONSTRAINT "work_order_operation_work_centre_id_work_centre_id_fk" FOREIGN KEY ("work_centre_id") REFERENCES "production"."work_centre"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production"."work_order_part" ADD CONSTRAINT "work_order_part_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "production"."work_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cutting_plan_order_idx" ON "production"."cutting_plan" USING btree ("tenant_id","work_order_id");--> statement-breakpoint
CREATE INDEX "finishing_batch_status_idx" ON "production"."finishing_batch" USING btree ("tenant_id","status","cure_completes_at");--> statement-breakpoint
CREATE INDEX "finishing_batch_part_part_idx" ON "production"."finishing_batch_part" USING btree ("tenant_id","part_id");--> statement-breakpoint
CREATE INDEX "production_scan_operation_idx" ON "production"."production_scan" USING btree ("tenant_id","operation_id","scanned_at");--> statement-breakpoint
CREATE INDEX "production_scan_operator_idx" ON "production"."production_scan" USING btree ("tenant_id","operator_id","scanned_at");--> statement-breakpoint
CREATE INDEX "production_scan_part_idx" ON "production"."production_scan" USING btree ("tenant_id","part_id");--> statement-breakpoint
CREATE INDEX "routing_operation_centre_idx" ON "production"."routing_operation" USING btree ("tenant_id","work_centre_id");--> statement-breakpoint
CREATE INDEX "work_centre_type_idx" ON "production"."work_centre" USING btree ("tenant_id","type","is_active");--> statement-breakpoint
CREATE INDEX "work_order_status_idx" ON "production"."work_order" USING btree ("tenant_id","status","priority");--> statement-breakpoint
CREATE INDEX "work_order_project_idx" ON "production"."work_order" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "work_order_operation_queue_idx" ON "production"."work_order_operation" USING btree ("tenant_id","work_centre_id","status");--> statement-breakpoint
CREATE INDEX "work_order_part_material_idx" ON "production"."work_order_part" USING btree ("tenant_id","material_item_id");