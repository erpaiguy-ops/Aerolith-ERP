CREATE SCHEMA "procurement";
--> statement-breakpoint
CREATE TYPE "procurement"."match_exception_code" AS ENUM('over_invoiced_quantity', 'no_receipt', 'price_variance', 'unmatched_line', 'over_receipt');--> statement-breakpoint
CREATE TYPE "procurement"."supplier_invoice_status" AS ENUM('received', 'matched', 'on_hold', 'approved', 'posted', 'paid', 'disputed', 'cancelled');--> statement-breakpoint
CREATE TYPE "procurement"."purchase_order_status" AS ENUM('draft', 'pending_approval', 'approved', 'issued', 'partially_received', 'received', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "procurement"."quote_status" AS ENUM('awaited', 'received', 'declined', 'shortlisted', 'awarded', 'lost', 'expired');--> statement-breakpoint
CREATE TYPE "procurement"."requisition_status" AS ENUM('draft', 'pending_approval', 'approved', 'sourcing', 'ordered', 'cancelled', 'rejected');--> statement-breakpoint
CREATE TYPE "procurement"."rfq_status" AS ENUM('draft', 'issued', 'closed', 'awarded', 'cancelled');--> statement-breakpoint
CREATE TABLE "procurement"."goods_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"received_on" date NOT NULL,
	"delivery_note_reference" varchar(64),
	"over_delivered" boolean DEFAULT false NOT NULL,
	"inspection_notes" text,
	"document_id" uuid,
	"received_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipt_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."goods_receipt_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"quantity_received" numeric(18, 4) NOT NULL,
	"quantity_rejected" numeric(18, 4) DEFAULT '0' NOT NULL,
	"rejection_reason" text,
	"unit_price" numeric(18, 4) NOT NULL,
	"accrual_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"stock_movement_id" uuid,
	"cost_entry_id" uuid,
	"batch_reference" varchar(64),
	"serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement"."match_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_invoice_id" uuid,
	"goods_receipt_id" uuid,
	"purchase_order_line_id" uuid,
	"code" "procurement"."match_exception_code" NOT NULL,
	"message" text NOT NULL,
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"is_favourable" boolean DEFAULT false NOT NULL,
	"resolution" varchar(24) DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_on" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement"."purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"supplier_id" uuid NOT NULL,
	"status" "procurement"."purchase_order_status" DEFAULT 'draft' NOT NULL,
	"project_id" uuid,
	"cost_centre_id" uuid,
	"source_quote_id" uuid,
	"source_rfq_id" uuid,
	"currency_code" varchar(3),
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"net_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"freight" numeric(18, 2) DEFAULT '0' NOT NULL,
	"other_charges" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"gross_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"base_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"payment_term_days" integer,
	"tax_code" varchar(32),
	"incoterm" varchar(16),
	"delivery_address" text,
	"promised_delivery_date" date,
	"commitment_id" uuid,
	"issued_on" date,
	"closed_on" date,
	"cancelled_reason" text,
	"approval_instance_id" uuid,
	"document_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."purchase_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"description" text NOT NULL,
	"specification" text,
	"quantity" numeric(18, 4) NOT NULL,
	"uom_code" varchar(16),
	"unit_price" numeric(18, 4) NOT NULL,
	"line_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_percent" numeric(6, 3),
	"quantity_received" numeric(18, 4) DEFAULT '0' NOT NULL,
	"quantity_invoiced" numeric(18, 4) DEFAULT '0' NOT NULL,
	"warehouse_id" uuid,
	"wbs_node_id" uuid,
	"requisition_line_id" uuid,
	"quote_line_id" uuid,
	"promised_delivery_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_line_uq" UNIQUE("purchase_order_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" "procurement"."quote_status" DEFAULT 'awaited' NOT NULL,
	"reference" varchar(64),
	"received_on" date,
	"valid_until" date,
	"declined_reason" text,
	"currency_code" varchar(3),
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"freight" numeric(18, 2) DEFAULT '0' NOT NULL,
	"duty_percent" numeric(6, 3) DEFAULT '0' NOT NULL,
	"other_charges" numeric(18, 2) DEFAULT '0' NOT NULL,
	"payment_term_days" integer DEFAULT 0 NOT NULL,
	"early_payment_discount_percent" numeric(6, 3),
	"early_payment_days" integer,
	"lead_time_days" integer,
	"landed_cost" numeric(18, 2),
	"effective_unit_cost" numeric(18, 4),
	"premium_over_best" numeric(18, 2),
	"compared_at" timestamp with time zone,
	"notes" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_supplier_uq" UNIQUE("rfq_id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE "procurement"."quote_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"rfq_line_id" uuid,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"offered_alternative" text,
	"quantity" numeric(18, 4) NOT NULL,
	"uom_code" varchar(16),
	"unit_price" numeric(18, 4) NOT NULL,
	"minimum_order_quantity" numeric(18, 4),
	"order_increment" numeric(18, 4),
	"lead_time_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_line_uq" UNIQUE("quote_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."requisition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"title" text NOT NULL,
	"status" "procurement"."requisition_status" DEFAULT 'draft' NOT NULL,
	"project_id" uuid,
	"cost_centre_id" uuid,
	"required_by" date,
	"priority" varchar(16) DEFAULT 'routine' NOT NULL,
	"justification" text,
	"estimated_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"source_estimate_id" uuid,
	"source_work_order_id" uuid,
	"approval_instance_id" uuid,
	"requested_by" uuid,
	"approved_by" uuid,
	"approved_on" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisition_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."requisition_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"description" text NOT NULL,
	"specification" text,
	"quantity" numeric(18, 4) NOT NULL,
	"uom_code" varchar(16),
	"estimated_unit_price" numeric(18, 4),
	"wbs_node_id" uuid,
	"quantity_ordered" numeric(18, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisition_line_uq" UNIQUE("requisition_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."rfq" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"title" text NOT NULL,
	"status" "procurement"."rfq_status" DEFAULT 'draft' NOT NULL,
	"project_id" uuid,
	"issued_on" date,
	"response_due_on" date,
	"currency_code" varchar(3),
	"surplus_is_stock" boolean DEFAULT true NOT NULL,
	"cost_of_capital_percent" numeric(6, 3),
	"award_rationale" text,
	"awarded_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_number_uq" UNIQUE("tenant_id","number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."rfq_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"item_id" uuid,
	"description" text NOT NULL,
	"specification" text,
	"quantity" numeric(18, 4) NOT NULL,
	"uom_code" varchar(16),
	"requisition_line_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_line_uq" UNIQUE("rfq_id","line_number")
);
--> statement-breakpoint
CREATE TABLE "procurement"."supplier_invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" varchar(48),
	"number_period" varchar(16),
	"number_value" integer,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"status" "procurement"."supplier_invoice_status" DEFAULT 'received' NOT NULL,
	"supplier_reference" varchar(64) NOT NULL,
	"invoice_date" date NOT NULL,
	"received_on" date NOT NULL,
	"due_on" date,
	"currency_code" varchar(3),
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"net_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"gross_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"base_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"supplier_tax_number" varchar(32),
	"tax_code" varchar(32),
	"matched_on" timestamp with time zone,
	"match_variance" numeric(18, 2),
	"hold_reason" text,
	"released_by" uuid,
	"released_on" timestamp with time zone,
	"approval_instance_id" uuid,
	"document_id" uuid,
	"posted_on" date,
	"paid_on" date,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_number_uq" UNIQUE("tenant_id","number"),
	CONSTRAINT "supplier_invoice_reference_uq" UNIQUE("tenant_id","supplier_id","supplier_reference")
);
--> statement-breakpoint
CREATE TABLE "procurement"."supplier_invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"purchase_order_line_id" uuid,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"uom_code" varchar(16),
	"unit_price" numeric(18, 4) NOT NULL,
	"line_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_percent" numeric(6, 3),
	"expected_value" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_line_uq" UNIQUE("supplier_invoice_id","line_number")
);
--> statement-breakpoint
ALTER TABLE "procurement"."goods_receipt" ADD CONSTRAINT "goods_receipt_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "procurement"."purchase_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_goods_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "procurement"."goods_receipt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_purchase_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "procurement"."purchase_order_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."match_exception" ADD CONSTRAINT "match_exception_supplier_invoice_id_supplier_invoice_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "procurement"."supplier_invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."match_exception" ADD CONSTRAINT "match_exception_goods_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "procurement"."goods_receipt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."match_exception" ADD CONSTRAINT "match_exception_purchase_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "procurement"."purchase_order_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."purchase_order" ADD CONSTRAINT "purchase_order_source_quote_id_quote_id_fk" FOREIGN KEY ("source_quote_id") REFERENCES "procurement"."quote"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."purchase_order" ADD CONSTRAINT "purchase_order_source_rfq_id_rfq_id_fk" FOREIGN KEY ("source_rfq_id") REFERENCES "procurement"."rfq"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "procurement"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_requisition_line_id_requisition_line_id_fk" FOREIGN KEY ("requisition_line_id") REFERENCES "procurement"."requisition_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_quote_line_id_quote_line_id_fk" FOREIGN KEY ("quote_line_id") REFERENCES "procurement"."quote_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."quote" ADD CONSTRAINT "quote_rfq_id_rfq_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "procurement"."rfq"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."quote_line" ADD CONSTRAINT "quote_line_quote_id_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "procurement"."quote"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."quote_line" ADD CONSTRAINT "quote_line_rfq_line_id_rfq_line_id_fk" FOREIGN KEY ("rfq_line_id") REFERENCES "procurement"."rfq_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."requisition_line" ADD CONSTRAINT "requisition_line_requisition_id_requisition_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "procurement"."requisition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."rfq_line" ADD CONSTRAINT "rfq_line_rfq_id_rfq_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "procurement"."rfq"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "procurement"."purchase_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."supplier_invoice_line" ADD CONSTRAINT "supplier_invoice_line_supplier_invoice_id_supplier_invoice_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "procurement"."supplier_invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement"."supplier_invoice_line" ADD CONSTRAINT "supplier_invoice_line_purchase_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "procurement"."purchase_order_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_order_idx" ON "procurement"."goods_receipt" USING btree ("tenant_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_date_idx" ON "procurement"."goods_receipt" USING btree ("tenant_id","received_on");--> statement-breakpoint
CREATE INDEX "goods_receipt_line_idx" ON "procurement"."goods_receipt_line" USING btree ("tenant_id","goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_line_order_idx" ON "procurement"."goods_receipt_line" USING btree ("tenant_id","purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "match_exception_invoice_idx" ON "procurement"."match_exception" USING btree ("tenant_id","supplier_invoice_id","resolution");--> statement-breakpoint
CREATE INDEX "match_exception_code_idx" ON "procurement"."match_exception" USING btree ("tenant_id","code","resolution");--> statement-breakpoint
CREATE INDEX "purchase_order_supplier_idx" ON "procurement"."purchase_order" USING btree ("tenant_id","supplier_id","status");--> statement-breakpoint
CREATE INDEX "purchase_order_project_idx" ON "procurement"."purchase_order" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "purchase_order_status_idx" ON "procurement"."purchase_order" USING btree ("tenant_id","status","promised_delivery_date");--> statement-breakpoint
CREATE INDEX "purchase_order_line_item_idx" ON "procurement"."purchase_order_line" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "purchase_order_line_wbs_idx" ON "procurement"."purchase_order_line" USING btree ("tenant_id","wbs_node_id");--> statement-breakpoint
CREATE INDEX "quote_status_idx" ON "procurement"."quote" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "quote_supplier_idx" ON "procurement"."quote" USING btree ("tenant_id","supplier_id");--> statement-breakpoint
CREATE INDEX "requisition_status_idx" ON "procurement"."requisition" USING btree ("tenant_id","status","required_by");--> statement-breakpoint
CREATE INDEX "requisition_project_idx" ON "procurement"."requisition" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "requisition_line_item_idx" ON "procurement"."requisition_line" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE INDEX "rfq_status_idx" ON "procurement"."rfq" USING btree ("tenant_id","status","response_due_on");--> statement-breakpoint
CREATE INDEX "supplier_invoice_status_idx" ON "procurement"."supplier_invoice" USING btree ("tenant_id","status","due_on");--> statement-breakpoint
CREATE INDEX "supplier_invoice_order_idx" ON "procurement"."supplier_invoice" USING btree ("tenant_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_line_order_idx" ON "procurement"."supplier_invoice_line" USING btree ("tenant_id","purchase_order_line_id");