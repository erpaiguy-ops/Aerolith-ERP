CREATE SCHEMA "inventory";
--> statement-breakpoint
CREATE TYPE "inventory"."count_status" AS ENUM('draft', 'counting', 'pending_approval', 'posted', 'cancelled');--> statement-breakpoint
CREATE TYPE "inventory"."movement_status" AS ENUM('draft', 'pending_approval', 'posted', 'cancelled');--> statement-breakpoint
CREATE TYPE "inventory"."movement_type" AS ENUM('receipt', 'issue', 'transfer', 'adjustment', 'return', 'scrap', 'production_output');--> statement-breakpoint
CREATE TYPE "inventory"."offcut_status" AS ENUM('available', 'reserved', 'consumed', 'scrapped');--> statement-breakpoint
CREATE TYPE "inventory"."warehouse_type" AS ENUM('factory', 'site', 'yard', 'transit', 'virtual');--> statement-breakpoint
CREATE TABLE "inventory"."batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"code" varchar(48) NOT NULL,
	"supplier_batch_ref" varchar(64),
	"supplier_id" uuid,
	"grain_code" varchar(32),
	"colour_code" varchar(32),
	"received_on" date,
	"expires_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_code_uq" UNIQUE("tenant_id","item_id","code")
);
--> statement-breakpoint
CREATE TABLE "inventory"."offcut" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"barcode" varchar(64) NOT NULL,
	"length_mm" numeric(12, 2) NOT NULL,
	"width_mm" numeric(12, 2) NOT NULL,
	"thickness_mm" numeric(12, 2),
	"area_sqm" numeric(12, 4) GENERATED ALWAYS AS (round((length_mm * width_mm) / 1000000.0, 4)) STORED,
	"grain_direction" varchar(8),
	"grain_code" varchar(32),
	"colour_code" varchar(32),
	"finished_edges" integer DEFAULT 0 NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid,
	"status" "inventory"."offcut_status" DEFAULT 'available' NOT NULL,
	"unit_cost" numeric(18, 6),
	"source_movement_id" uuid,
	"source_project_id" uuid,
	"consumed_by_movement_id" uuid,
	"reserved_for_project_id" uuid,
	"consumed_at" timestamp with time zone,
	"scrapped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offcut_barcode_uq" UNIQUE("tenant_id","barcode")
);
--> statement-breakpoint
CREATE TABLE "inventory"."reorder_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"minimum_quantity" numeric(18, 4) NOT NULL,
	"reorder_quantity" numeric(18, 4) NOT NULL,
	"maximum_quantity" numeric(18, 4),
	"lead_time_days" integer DEFAULT 14 NOT NULL,
	"preferred_supplier_id" uuid,
	"last_triggered_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reorder_rule_uq" UNIQUE("tenant_id","item_id","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"warehouse_id" uuid NOT NULL,
	"status" "inventory"."count_status" DEFAULT 'draft' NOT NULL,
	"count_date" date NOT NULL,
	"item_category_id" uuid,
	"counted_by" uuid,
	"approval_instance_id" uuid,
	"adjustment_movement_id" uuid,
	"posted_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_count_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"bin_id" uuid,
	"batch_id" uuid,
	"system_quantity" numeric(18, 4) NOT NULL,
	"counted_quantity" numeric(18, 4),
	"variance" numeric(18, 4) GENERATED ALWAYS AS (counted_quantity - system_quantity) STORED,
	"variance_reason" text,
	"counted_at" timestamp with time zone,
	"counted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_line_uq" UNIQUE NULLS NOT DISTINCT("count_id","item_id","bin_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_level" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"bin_id" uuid,
	"batch_id" uuid,
	"quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"reserved_quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"available_quantity" numeric(18, 4) GENERATED ALWAYS AS (quantity - reserved_quantity) STORED,
	"average_cost" numeric(18, 6) DEFAULT '0' NOT NULL,
	"last_movement_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_level_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","item_id","warehouse_id","bin_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"type" "inventory"."movement_type" NOT NULL,
	"status" "inventory"."movement_status" DEFAULT 'draft' NOT NULL,
	"movement_date" date NOT NULL,
	"project_id" uuid,
	"party_id" uuid,
	"cost_code_id" uuid,
	"source_module" varchar(64),
	"source_entity_type" varchar(96),
	"source_entity_id" uuid,
	"reference" varchar(96),
	"notes" text,
	"approval_instance_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reverses_movement_id" uuid,
	"cancelled_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "inventory"."stock_movement_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"from_warehouse_id" uuid,
	"from_bin_id" uuid,
	"to_warehouse_id" uuid,
	"to_bin_id" uuid,
	"quantity" numeric(18, 4) NOT NULL,
	"uom_id" uuid,
	"stock_quantity" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 6),
	"total_cost" numeric(18, 4),
	"offcut_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_line_uq" UNIQUE("movement_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "inventory"."storage_bin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text,
	"barcode" varchar(64),
	"max_length_mm" numeric(12, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_bin_uq" UNIQUE("tenant_id","warehouse_id","code")
);
--> statement-breakpoint
CREATE TABLE "inventory"."warehouse" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"type" "inventory"."warehouse_type" DEFAULT 'factory' NOT NULL,
	"project_id" uuid,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manager_id" uuid,
	"is_issue_blocked" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
ALTER TABLE "inventory"."offcut" ADD CONSTRAINT "offcut_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "inventory"."batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."offcut" ADD CONSTRAINT "offcut_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "inventory"."warehouse"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."offcut" ADD CONSTRAINT "offcut_bin_id_storage_bin_id_fk" FOREIGN KEY ("bin_id") REFERENCES "inventory"."storage_bin"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."offcut" ADD CONSTRAINT "offcut_source_movement_id_stock_movement_id_fk" FOREIGN KEY ("source_movement_id") REFERENCES "inventory"."stock_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."offcut" ADD CONSTRAINT "offcut_consumed_by_movement_id_stock_movement_id_fk" FOREIGN KEY ("consumed_by_movement_id") REFERENCES "inventory"."stock_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."reorder_rule" ADD CONSTRAINT "reorder_rule_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "inventory"."warehouse"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_count" ADD CONSTRAINT "stock_count_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "inventory"."warehouse"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_count" ADD CONSTRAINT "stock_count_adjustment_movement_id_stock_movement_id_fk" FOREIGN KEY ("adjustment_movement_id") REFERENCES "inventory"."stock_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_count_line" ADD CONSTRAINT "stock_count_line_count_id_stock_count_id_fk" FOREIGN KEY ("count_id") REFERENCES "inventory"."stock_count"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_count_line" ADD CONSTRAINT "stock_count_line_bin_id_storage_bin_id_fk" FOREIGN KEY ("bin_id") REFERENCES "inventory"."storage_bin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_count_line" ADD CONSTRAINT "stock_count_line_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "inventory"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_level" ADD CONSTRAINT "stock_level_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "inventory"."warehouse"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_level" ADD CONSTRAINT "stock_level_bin_id_storage_bin_id_fk" FOREIGN KEY ("bin_id") REFERENCES "inventory"."storage_bin"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_level" ADD CONSTRAINT "stock_level_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "inventory"."batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movement_line" ADD CONSTRAINT "stock_movement_line_movement_id_stock_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "inventory"."stock_movement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movement_line" ADD CONSTRAINT "stock_movement_line_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "inventory"."batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movement_line" ADD CONSTRAINT "stock_movement_line_from_warehouse_id_warehouse_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "inventory"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movement_line" ADD CONSTRAINT "stock_movement_line_from_bin_id_storage_bin_id_fk" FOREIGN KEY ("from_bin_id") REFERENCES "inventory"."storage_bin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movement_line" ADD CONSTRAINT "stock_movement_line_to_warehouse_id_warehouse_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "inventory"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."stock_movement_line" ADD CONSTRAINT "stock_movement_line_to_bin_id_storage_bin_id_fk" FOREIGN KEY ("to_bin_id") REFERENCES "inventory"."storage_bin"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."storage_bin" ADD CONSTRAINT "storage_bin_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "inventory"."warehouse"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_item_idx" ON "inventory"."batch" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "offcut_search_idx" ON "inventory"."offcut" USING btree ("tenant_id","item_id","status","area_sqm");--> statement-breakpoint
CREATE INDEX "offcut_warehouse_idx" ON "inventory"."offcut" USING btree ("tenant_id","warehouse_id","status");--> statement-breakpoint
CREATE INDEX "reorder_rule_active_idx" ON "inventory"."reorder_rule" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "stock_count_status_idx" ON "inventory"."stock_count" USING btree ("tenant_id","status","count_date");--> statement-breakpoint
CREATE INDEX "stock_count_line_count_idx" ON "inventory"."stock_count_line" USING btree ("tenant_id","count_id");--> statement-breakpoint
CREATE INDEX "stock_level_item_idx" ON "inventory"."stock_level" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "stock_level_warehouse_idx" ON "inventory"."stock_level" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_movement_status_idx" ON "inventory"."stock_movement" USING btree ("tenant_id","status","movement_date");--> statement-breakpoint
CREATE INDEX "stock_movement_project_idx" ON "inventory"."stock_movement" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "stock_movement_source_idx" ON "inventory"."stock_movement" USING btree ("tenant_id","source_entity_type","source_entity_id");--> statement-breakpoint
CREATE INDEX "stock_movement_line_item_idx" ON "inventory"."stock_movement_line" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "storage_bin_barcode_idx" ON "inventory"."storage_bin" USING btree ("tenant_id","barcode");--> statement-breakpoint
CREATE INDEX "warehouse_active_idx" ON "inventory"."warehouse" USING btree ("tenant_id","is_active");