CREATE SCHEMA "kernel";
--> statement-breakpoint
CREATE TYPE "kernel"."approval_decision" AS ENUM('approved', 'rejected', 'delegated', 'recalled', 'escalated', 'auto_approved', 'skipped');--> statement-breakpoint
CREATE TYPE "kernel"."approval_state" AS ENUM('draft', 'pending', 'approved', 'rejected', 'cancelled', 'recalled', 'expired', 'skipped');--> statement-breakpoint
CREATE TYPE "kernel"."approver_type" AS ENUM('role', 'user', 'manager_of_requester', 'department_head', 'project_manager', 'legal_entity_owner', 'cost_centre_owner', 'dynamic');--> statement-breakpoint
CREATE TYPE "kernel"."quorum_rule" AS ENUM('all', 'any', 'majority', 'count');--> statement-breakpoint
CREATE TYPE "kernel"."audit_action" AS ENUM('create', 'update', 'delete', 'read', 'approve', 'reject', 'submit', 'cancel', 'post', 'reverse', 'login', 'logout', 'export', 'permission_change');--> statement-breakpoint
CREATE TYPE "kernel"."custom_field_type" AS ENUM('text', 'textarea', 'number', 'decimal', 'boolean', 'date', 'datetime', 'select', 'multiselect', 'user', 'party', 'item', 'project', 'document', 'url');--> statement-breakpoint
CREATE TYPE "kernel"."document_status" AS ENUM('uploading', 'processing', 'available', 'quarantined', 'failed');--> statement-breakpoint
CREATE TYPE "kernel"."outbox_status" AS ENUM('pending', 'processing', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "kernel"."membership_status" AS ENUM('invited', 'active', 'suspended', 'removed');--> statement-breakpoint
CREATE TYPE "kernel"."holiday_calculation" AS ENUM('fixed_gregorian', 'hijri', 'announced', 'observed_weekday');--> statement-breakpoint
CREATE TYPE "kernel"."requirement_category" AS ENUM('identity', 'immigration', 'licence', 'insurance', 'permit', 'registration', 'certification', 'tax', 'health', 'other');--> statement-breakpoint
CREATE TYPE "kernel"."requirement_subject" AS ENUM('employee', 'dependent', 'company', 'establishment', 'vehicle', 'asset', 'project', 'accommodation', 'subcontractor', 'supplier');--> statement-breakpoint
CREATE TYPE "kernel"."rule_domain" AS ENUM('payroll', 'hr', 'tax', 'accounting', 'contract', 'procurement', 'inventory', 'production', 'logistics', 'accommodation', 'compliance', 'document', 'general');--> statement-breakpoint
CREATE TYPE "kernel"."rule_value_type" AS ENUM('boolean', 'number', 'percent', 'money', 'string', 'enum', 'date', 'duration', 'json');--> statement-breakpoint
CREATE TYPE "kernel"."tax_applicability" AS ENUM('sales', 'purchase', 'both');--> statement-breakpoint
CREATE TYPE "kernel"."tax_regime_type" AS ENUM('vat', 'gst', 'sales_tax', 'none');--> statement-breakpoint
CREATE TYPE "kernel"."item_type" AS ENUM('raw_material', 'panel', 'hardware', 'consumable', 'finished_good', 'sub_assembly', 'service', 'asset');--> statement-breakpoint
CREATE TYPE "kernel"."party_type" AS ENUM('organisation', 'individual');--> statement-breakpoint
CREATE TYPE "kernel"."delivery_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "kernel"."notification_channel" AS ENUM('in_app', 'email', 'telegram', 'whatsapp', 'sms', 'webhook');--> statement-breakpoint
CREATE TYPE "kernel"."reset_frequency" AS ENUM('never', 'yearly', 'monthly', 'fiscal_year');--> statement-breakpoint
CREATE TYPE "kernel"."permission_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "kernel"."module_status" AS ENUM('enabled', 'trial', 'disabled', 'expired');--> statement-breakpoint
CREATE TYPE "kernel"."tenant_status" AS ENUM('trial', 'active', 'past_due', 'suspended', 'cancelled');--> statement-breakpoint
CREATE TABLE "kernel"."approval_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"task_id" uuid,
	"sequence" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"decision" "kernel"."approval_decision" NOT NULL,
	"comment" text,
	"document_ids" uuid[],
	"delegated_to" uuid,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."approval_delegation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"entity_types" text[],
	"max_amount" numeric(18, 2),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."approval_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(96) NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_label" text,
	"module_key" varchar(64) NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"state" "kernel"."approval_state" DEFAULT 'pending' NOT NULL,
	"current_sequence" integer DEFAULT 1 NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount" numeric(18, 2),
	"currency_code" varchar(3),
	"legal_entity_id" uuid,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."approval_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"step_name" text NOT NULL,
	"approver_id" uuid NOT NULL,
	"delegated_from" uuid,
	"state" "kernel"."approval_state" DEFAULT 'pending' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."approval_workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(96) NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"fallback_behaviour" varchar(16) DEFAULT 'block' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_workflow_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."approval_workflow_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_workflow_version_uq" UNIQUE("workflow_id","version")
);
--> statement-breakpoint
CREATE TABLE "kernel"."authority_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"role_id" uuid,
	"user_id" uuid,
	"entity_type" varchar(96) NOT NULL,
	"min_amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"max_amount" numeric(18, 2),
	"currency_code" varchar(3) NOT NULL,
	"cost_centre_ids" uuid[] DEFAULT '{}'::uuid[],
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"actor_type" varchar(16) DEFAULT 'user' NOT NULL,
	"on_behalf_of_id" uuid,
	"module_key" varchar(64),
	"entity_type" varchar(96) NOT NULL,
	"entity_id" uuid,
	"entity_label" text,
	"action" "kernel"."audit_action" NOT NULL,
	"changes" jsonb,
	"redacted_fields" text[],
	"request_id" uuid,
	"ip_address" "inet",
	"user_agent" text,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."custom_field_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(96) NOT NULL,
	"module_key" varchar(64),
	"key" varchar(64) NOT NULL,
	"label" text NOT NULL,
	"label_native" text,
	"help_text" text,
	"type" "kernel"."custom_field_type" NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_searchable" boolean DEFAULT false NOT NULL,
	"show_in_list" boolean DEFAULT false NOT NULL,
	"default_value" jsonb,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visible_when" jsonb,
	"section" varchar(64),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_field_definition_uq" UNIQUE("tenant_id","entity_type","key")
);
--> statement-breakpoint
CREATE TABLE "kernel"."document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"document_type" varchar(64),
	"status" "kernel"."document_status" DEFAULT 'uploading' NOT NULL,
	"current_version_id" uuid,
	"version_count" integer DEFAULT 0 NOT NULL,
	"reference_number" varchar(64),
	"revision" varchar(16),
	"requirement_id" uuid,
	"expires_on" date,
	"tags" text[],
	"extracted_text" text,
	"ocr_completed_at" timestamp with time zone,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"retain_until" date,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "kernel"."document_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"entity_type" varchar(96) NOT NULL,
	"entity_id" uuid NOT NULL,
	"module_key" varchar(64) NOT NULL,
	"link_type" varchar(32) DEFAULT 'attachment' NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_link_uq" UNIQUE("document_id","entity_type","entity_id","link_type")
);
--> statement-breakpoint
CREATE TABLE "kernel"."document_lock" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"locked_by" uuid NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "kernel"."document_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"uploaded_by" uuid,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_version_uq" UNIQUE("document_id","version")
);
--> statement-breakpoint
CREATE TABLE "kernel"."folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"owner_entity_type" varchar(96),
	"owner_entity_id" uuid,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "folder_path_uq" UNIQUE("tenant_id","path")
);
--> statement-breakpoint
CREATE TABLE "kernel"."event_consumption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"consumer_key" varchar(128) NOT NULL,
	"tenant_id" uuid NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	CONSTRAINT "event_consumption_uq" UNIQUE("event_id","consumer_key")
);
--> statement-breakpoint
CREATE TABLE "kernel"."event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"source_module" varchar(64) NOT NULL,
	"aggregate_type" varchar(96) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" uuid,
	"causation_id" uuid,
	"status" "kernel"."outbox_status" DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."scheduled_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"job_key" varchar(128) NOT NULL,
	"module_key" varchar(64),
	"cron" varchar(64),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" varchar(16),
	"last_error" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "kernel"."app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"name" text NOT NULL,
	"avatar_url" text,
	"phone" varchar(32),
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"timezone" text,
	"totp_secret" text,
	"totp_enabled_at" timestamp with time zone,
	"recovery_codes" text[],
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "kernel"."membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "kernel"."membership_status" DEFAULT 'invited' NOT NULL,
	"employee_id" uuid,
	"legal_entity_id" uuid,
	"is_owner" boolean DEFAULT false NOT NULL,
	"invited_by" uuid,
	"invited_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_uq" UNIQUE("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "kernel"."session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"mfa_satisfied_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "kernel"."country" (
	"code" char(2) PRIMARY KEY NOT NULL,
	"code3" char(3) NOT NULL,
	"numeric_code" char(3),
	"name" text NOT NULL,
	"native_name" text,
	"currency_code" char(3) NOT NULL,
	"default_locale" varchar(10) DEFAULT 'en' NOT NULL,
	"supported_locales" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_rtl_default" boolean DEFAULT false NOT NULL,
	"default_timezone" text NOT NULL,
	"date_format" varchar(32) DEFAULT 'dd/MM/yyyy' NOT NULL,
	"weekend_days" smallint[] DEFAULT '{6,7}'::smallint[] NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"admin_division_label" text DEFAULT 'Region' NOT NULL,
	"address_format" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phone_code" varchar(8),
	"phone_format" varchar(32),
	"pack_version" varchar(32),
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."country_admin_division" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" char(2) NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"native_name" text,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "country_admin_division_uq" UNIQUE("country_code","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."country_rule_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" char(2) NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" jsonb NOT NULL,
	"source_reference" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "country_rule_value_uq" UNIQUE("country_code","key","effective_from")
);
--> statement-breakpoint
CREATE TABLE "kernel"."holiday_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" char(2) NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"native_name" text,
	"calculation" "kernel"."holiday_calculation" NOT NULL,
	"rule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_duration_days" numeric(4, 1) DEFAULT '1' NOT NULL,
	"is_paid" boolean DEFAULT true NOT NULL,
	"applies_to_divisions" text[],
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holiday_definition_uq" UNIQUE("country_code","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."requirement_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" char(2) NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"native_name" text,
	"description" text,
	"subject" "kernel"."requirement_subject" NOT NULL,
	"category" "kernel"."requirement_category" NOT NULL,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"has_expiry" boolean DEFAULT true NOT NULL,
	"expiry_notice_days" integer[] DEFAULT '{90,60,30,7}'::integer[] NOT NULL,
	"renewal_lead_days" integer DEFAULT 30 NOT NULL,
	"typical_validity_months" integer,
	"number_format_regex" text,
	"number_format_hint" text,
	"issuing_authority" text,
	"blocks_onboarding" boolean DEFAULT false NOT NULL,
	"blocks_site_access" boolean DEFAULT false NOT NULL,
	"requires_document_copy" boolean DEFAULT true NOT NULL,
	"additional_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_definition_uq" UNIQUE("country_code","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."rule_definition" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"domain" "kernel"."rule_domain" NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"value_type" "kernel"."rule_value_type" NOT NULL,
	"value_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_value" jsonb,
	"unit" varchar(24),
	"tenant_overridable" boolean DEFAULT true NOT NULL,
	"owner_module" varchar(64),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."tax_code_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"regime_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"applicability" "kernel"."tax_applicability" DEFAULT 'both' NOT NULL,
	"is_recoverable" boolean DEFAULT true NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"return_box" varchar(16),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_code_definition_uq" UNIQUE("regime_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."tax_regime" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" char(2) NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"type" "kernel"."tax_regime_type" NOT NULL,
	"registration_label" varchar(32) DEFAULT 'Tax No.' NOT NULL,
	"registration_regex" text,
	"registration_hint" text,
	"filing_frequency" varchar(16) DEFAULT 'quarterly' NOT NULL,
	"supports_reverse_charge" boolean DEFAULT false NOT NULL,
	"supports_designated_zones" boolean DEFAULT false NOT NULL,
	"registration_threshold" numeric(18, 2),
	"einvoicing_scheme" varchar(32),
	"einvoicing_mandatory_from" date,
	"einvoicing_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_regime_uq" UNIQUE("country_code","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."tenant_holiday" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_definition_id" uuid,
	"country_code" char(2) NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"is_paid" boolean DEFAULT true NOT NULL,
	"is_confirmed" boolean DEFAULT false NOT NULL,
	"applies_to_divisions" text[],
	"is_user_defined" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."tenant_localisation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"country_code" char(2) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"currency_code" char(3) NOT NULL,
	"timezone" text NOT NULL,
	"weekend_days" smallint[] NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"tax_registration_number" varchar(64),
	"tax_regime_code" varchar(32),
	"adopted_pack_version" varchar(32),
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pack_update_available" varchar(32),
	"setup_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_localisation_uq" UNIQUE("tenant_id","country_code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."tenant_requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_definition_id" uuid,
	"country_code" char(2) NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"native_name" text,
	"subject" "kernel"."requirement_subject" NOT NULL,
	"category" "kernel"."requirement_category" NOT NULL,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"has_expiry" boolean DEFAULT true NOT NULL,
	"expiry_notice_days" integer[] DEFAULT '{90,60,30,7}'::integer[] NOT NULL,
	"renewal_lead_days" integer DEFAULT 30 NOT NULL,
	"typical_validity_months" integer,
	"number_format_regex" text,
	"number_format_hint" text,
	"issuing_authority" text,
	"blocks_onboarding" boolean DEFAULT false NOT NULL,
	"blocks_site_access" boolean DEFAULT false NOT NULL,
	"requires_document_copy" boolean DEFAULT true NOT NULL,
	"additional_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_customised" boolean DEFAULT false NOT NULL,
	"is_user_defined" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_requirement_uq" UNIQUE("tenant_id","country_code","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."tenant_rule_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" jsonb NOT NULL,
	"reason" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_rule_value_uq" UNIQUE("tenant_id","key","effective_from")
);
--> statement-breakpoint
CREATE TABLE "kernel"."tenant_tax_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_definition_id" uuid,
	"country_code" char(2) NOT NULL,
	"regime_code" varchar(32) NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"applicability" "kernel"."tax_applicability" DEFAULT 'both' NOT NULL,
	"is_recoverable" boolean DEFAULT true NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"return_box" varchar(16),
	"output_account_id" uuid,
	"input_account_id" uuid,
	"is_customised" boolean DEFAULT false NOT NULL,
	"is_user_defined" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_tax_code_uq" UNIQUE("tenant_id","regime_code","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."cost_centre" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"parent_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_centre_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."cost_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"cost_type" varchar(16) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."currency" (
	"code" varchar(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" varchar(8),
	"decimal_places" integer DEFAULT 2 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."exchange_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_currency" varchar(3) NOT NULL,
	"to_currency" varchar(3) NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"valid_on" date NOT NULL,
	"source" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rate_uq" UNIQUE("tenant_id","from_currency","to_currency","valid_on")
);
--> statement-breakpoint
CREATE TABLE "kernel"."item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(48) NOT NULL,
	"name" text NOT NULL,
	"native_name" text,
	"description" text,
	"type" "kernel"."item_type" NOT NULL,
	"category_id" uuid,
	"stock_uom_id" uuid,
	"purchase_uom_id" uuid,
	"length_mm" numeric(12, 2),
	"width_mm" numeric(12, 2),
	"thickness_mm" numeric(12, 2),
	"has_grain_direction" boolean DEFAULT false NOT NULL,
	"finish_code" varchar(32),
	"colour_code" varchar(32),
	"is_stocked" boolean DEFAULT true NOT NULL,
	"is_batch_tracked" boolean DEFAULT false NOT NULL,
	"is_serial_tracked" boolean DEFAULT false NOT NULL,
	"barcode" varchar(64),
	"default_tax_code_id" uuid,
	"standard_cost" numeric(18, 4),
	"wastage_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "item_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."item_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_category_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."party" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"type" "kernel"."party_type" DEFAULT 'organisation' NOT NULL,
	"name" text NOT NULL,
	"native_name" text,
	"legal_name" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_subcontractor" boolean DEFAULT false NOT NULL,
	"is_consultant" boolean DEFAULT false NOT NULL,
	"is_employee" boolean DEFAULT false NOT NULL,
	"country_code" varchar(2),
	"admin_division_code" varchar(16),
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email" varchar(320),
	"phone" varchar(32),
	"website" text,
	"tax_registration_number" varchar(64),
	"registrations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency_code" varchar(3),
	"payment_term_days" integer,
	"credit_limit" numeric(18, 2),
	"is_blocked" boolean DEFAULT false NOT NULL,
	"block_reason" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "party_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."party_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"name" text NOT NULL,
	"job_title" text,
	"email" varchar(320),
	"phone" varchar(32),
	"is_primary" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "kernel"."project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"code" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"client_party_id" uuid,
	"status" varchar(24) DEFAULT 'lead' NOT NULL,
	"currency_code" varchar(3),
	"contract_value" numeric(18, 2),
	"start_date" date,
	"end_date" date,
	"country_code" varchar(2),
	"site_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "project_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."unit_of_measure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"dimension" varchar(16) NOT NULL,
	"conversion_factor" numeric(18, 8) DEFAULT '1' NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"decimal_places" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_of_measure_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type_key" varchar(128) NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity_type" varchar(96),
	"entity_id" uuid,
	"action_url" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "kernel"."notification_channel" NOT NULL,
	"destination" text NOT NULL,
	"status" "kernel"."delivery_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type_key" varchar(128) NOT NULL,
	"channels" text[] NOT NULL,
	"quiet_hours_start" varchar(5),
	"quiet_hours_end" varchar(5),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preference_uq" UNIQUE("tenant_id","user_id","type_key")
);
--> statement-breakpoint
CREATE TABLE "kernel"."notification_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type_key" varchar(128) NOT NULL,
	"channel" "kernel"."notification_channel" NOT NULL,
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_template_uq" UNIQUE("tenant_id","type_key","channel","locale")
);
--> statement-breakpoint
CREATE TABLE "kernel"."notification_type" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"module_key" varchar(64) NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"default_channels" text[] NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."number_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"period" varchar(16) NOT NULL,
	"value" integer NOT NULL,
	"formatted" text NOT NULL,
	"entity_id" uuid,
	"is_voided" boolean DEFAULT false NOT NULL,
	"void_reason" text,
	"allocated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_allocation_uq" UNIQUE("series_id","period","value")
);
--> statement-breakpoint
CREATE TABLE "kernel"."number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(96) NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"pattern" text NOT NULL,
	"prefix" varchar(16),
	"suffix" varchar(16),
	"padding" smallint DEFAULT 5 NOT NULL,
	"start_value" integer DEFAULT 1 NOT NULL,
	"increment" integer DEFAULT 1 NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"reset_frequency" "kernel"."reset_frequency" DEFAULT 'yearly' NOT NULL,
	"last_reset_period" varchar(16),
	"legal_entity_id" uuid,
	"is_gapless" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."permission" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"module_key" varchar(64) NOT NULL,
	"resource" varchar(64) NOT NULL,
	"action" varchar(32) NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"category" varchar(64),
	"is_dangerous" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kernel"."role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_approval_target" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."role_permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_key" varchar(128) NOT NULL,
	"effect" "kernel"."permission_effect" DEFAULT 'allow' NOT NULL,
	"conditions" jsonb,
	"fields" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_uq" UNIQUE("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "kernel"."user_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" varchar(32),
	"scope_id" uuid,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_uq" UNIQUE("tenant_id","user_id","role_id","scope_type","scope_id")
);
--> statement-breakpoint
CREATE TABLE "kernel"."legal_entity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"country_code" varchar(2) NOT NULL,
	"admin_division_code" varchar(16),
	"base_currency_code" varchar(3) NOT NULL,
	"registrations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tax_registration_number" varchar(64),
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_entity_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "kernel"."tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(63) NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"status" "kernel"."tenant_status" DEFAULT 'trial' NOT NULL,
	"primary_country_code" varchar(2),
	"base_currency_code" varchar(3),
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"default_locale" varchar(10) DEFAULT 'en' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "kernel"."tenant_module" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_key" varchar(64) NOT NULL,
	"status" "kernel"."module_status" DEFAULT 'enabled' NOT NULL,
	"version" varchar(32),
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_on" date,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_module_uq" UNIQUE("tenant_id","module_key")
);
--> statement-breakpoint
ALTER TABLE "kernel"."approval_action" ADD CONSTRAINT "approval_action_instance_id_approval_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "kernel"."approval_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."approval_instance" ADD CONSTRAINT "approval_instance_workflow_version_id_approval_workflow_version_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "kernel"."approval_workflow_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."approval_task" ADD CONSTRAINT "approval_task_instance_id_approval_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "kernel"."approval_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."approval_workflow_version" ADD CONSTRAINT "approval_workflow_version_workflow_id_approval_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "kernel"."approval_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."document_link" ADD CONSTRAINT "document_link_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "kernel"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."document_lock" ADD CONSTRAINT "document_lock_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "kernel"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."document_version" ADD CONSTRAINT "document_version_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "kernel"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."membership" ADD CONSTRAINT "membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "kernel"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "kernel"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."country_admin_division" ADD CONSTRAINT "country_admin_division_country_code_country_code_fk" FOREIGN KEY ("country_code") REFERENCES "kernel"."country"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."country_rule_value" ADD CONSTRAINT "country_rule_value_country_code_country_code_fk" FOREIGN KEY ("country_code") REFERENCES "kernel"."country"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."country_rule_value" ADD CONSTRAINT "country_rule_value_key_rule_definition_key_fk" FOREIGN KEY ("key") REFERENCES "kernel"."rule_definition"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."holiday_definition" ADD CONSTRAINT "holiday_definition_country_code_country_code_fk" FOREIGN KEY ("country_code") REFERENCES "kernel"."country"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."requirement_definition" ADD CONSTRAINT "requirement_definition_country_code_country_code_fk" FOREIGN KEY ("country_code") REFERENCES "kernel"."country"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."tax_code_definition" ADD CONSTRAINT "tax_code_definition_regime_id_tax_regime_id_fk" FOREIGN KEY ("regime_id") REFERENCES "kernel"."tax_regime"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."tax_regime" ADD CONSTRAINT "tax_regime_country_code_country_code_fk" FOREIGN KEY ("country_code") REFERENCES "kernel"."country"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."party_contact" ADD CONSTRAINT "party_contact_party_id_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "kernel"."party"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "kernel"."notification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."number_allocation" ADD CONSTRAINT "number_allocation_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "kernel"."number_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "kernel"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kernel"."user_role" ADD CONSTRAINT "user_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "kernel"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_action_instance_idx" ON "kernel"."approval_action" USING btree ("instance_id","acted_at");--> statement-breakpoint
CREATE INDEX "approval_delegation_active_idx" ON "kernel"."approval_delegation" USING btree ("tenant_id","from_user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "approval_instance_entity_idx" ON "kernel"."approval_instance" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "approval_instance_state_idx" ON "kernel"."approval_instance" USING btree ("tenant_id","state","due_at");--> statement-breakpoint
CREATE INDEX "approval_instance_requester_idx" ON "kernel"."approval_instance" USING btree ("tenant_id","requested_by");--> statement-breakpoint
CREATE INDEX "approval_task_inbox_idx" ON "kernel"."approval_task" USING btree ("tenant_id","approver_id","state","due_at");--> statement-breakpoint
CREATE INDEX "approval_task_instance_idx" ON "kernel"."approval_task" USING btree ("instance_id","sequence");--> statement-breakpoint
CREATE INDEX "approval_workflow_entity_idx" ON "kernel"."approval_workflow" USING btree ("tenant_id","entity_type","is_active");--> statement-breakpoint
CREATE INDEX "approval_workflow_version_current_idx" ON "kernel"."approval_workflow_version" USING btree ("tenant_id","workflow_id","is_current");--> statement-breakpoint
CREATE INDEX "authority_limit_lookup_idx" ON "kernel"."authority_limit" USING btree ("tenant_id","entity_type","is_active");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "kernel"."audit_log" USING btree ("tenant_id","entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "kernel"."audit_log" USING btree ("tenant_id","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_time_idx" ON "kernel"."audit_log" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "custom_field_definition_entity_idx" ON "kernel"."custom_field_definition" USING btree ("tenant_id","entity_type","is_active");--> statement-breakpoint
CREATE INDEX "document_folder_idx" ON "kernel"."document" USING btree ("tenant_id","folder_id");--> statement-breakpoint
CREATE INDEX "document_type_idx" ON "kernel"."document" USING btree ("tenant_id","document_type");--> statement-breakpoint
CREATE INDEX "document_expiry_idx" ON "kernel"."document" USING btree ("tenant_id","expires_on");--> statement-breakpoint
CREATE INDEX "document_reference_idx" ON "kernel"."document" USING btree ("tenant_id","reference_number","revision");--> statement-breakpoint
CREATE INDEX "document_link_entity_idx" ON "kernel"."document_link" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "document_lock_tenant_idx" ON "kernel"."document_lock" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "document_version_checksum_idx" ON "kernel"."document_version" USING btree ("tenant_id","checksum");--> statement-breakpoint
CREATE INDEX "folder_parent_idx" ON "kernel"."folder" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "event_outbox_dispatch_idx" ON "kernel"."event_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "event_outbox_aggregate_idx" ON "kernel"."event_outbox" USING btree ("tenant_id","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "event_outbox_type_idx" ON "kernel"."event_outbox" USING btree ("tenant_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "scheduled_job_next_idx" ON "kernel"."scheduled_job" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "api_key_tenant_idx" ON "kernel"."api_key" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "app_user_email_idx" ON "kernel"."app_user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "kernel"."membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "kernel"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expiry_idx" ON "kernel"."session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "country_active_idx" ON "kernel"."country" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "country_rule_value_lookup_idx" ON "kernel"."country_rule_value" USING btree ("country_code","key");--> statement-breakpoint
CREATE INDEX "requirement_definition_subject_idx" ON "kernel"."requirement_definition" USING btree ("country_code","subject");--> statement-breakpoint
CREATE INDEX "rule_definition_domain_idx" ON "kernel"."rule_definition" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "tenant_holiday_range_idx" ON "kernel"."tenant_holiday" USING btree ("tenant_id","start_date","end_date");--> statement-breakpoint
CREATE INDEX "tenant_localisation_primary_idx" ON "kernel"."tenant_localisation" USING btree ("tenant_id","is_primary");--> statement-breakpoint
CREATE INDEX "tenant_requirement_subject_idx" ON "kernel"."tenant_requirement" USING btree ("tenant_id","subject","is_active");--> statement-breakpoint
CREATE INDEX "tenant_rule_value_lookup_idx" ON "kernel"."tenant_rule_value" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "tenant_tax_code_lookup_idx" ON "kernel"."tenant_tax_code" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "exchange_rate_lookup_idx" ON "kernel"."exchange_rate" USING btree ("tenant_id","from_currency","to_currency","valid_on");--> statement-breakpoint
CREATE INDEX "item_type_idx" ON "kernel"."item" USING btree ("tenant_id","type","is_active");--> statement-breakpoint
CREATE INDEX "item_barcode_idx" ON "kernel"."item" USING btree ("tenant_id","barcode");--> statement-breakpoint
CREATE INDEX "party_name_idx" ON "kernel"."party" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "party_role_idx" ON "kernel"."party" USING btree ("tenant_id","is_customer","is_supplier","is_subcontractor");--> statement-breakpoint
CREATE INDEX "party_contact_party_idx" ON "kernel"."party_contact" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE INDEX "project_status_idx" ON "kernel"."project" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "notification_inbox_idx" ON "kernel"."notification" USING btree ("tenant_id","recipient_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_status_idx" ON "kernel"."notification_delivery" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "notification_type_module_idx" ON "kernel"."notification_type" USING btree ("module_key");--> statement-breakpoint
CREATE INDEX "number_allocation_entity_idx" ON "kernel"."number_allocation" USING btree ("tenant_id","entity_id");--> statement-breakpoint
CREATE INDEX "number_allocation_period_idx" ON "kernel"."number_allocation" USING btree ("series_id","period","value");--> statement-breakpoint
CREATE INDEX "number_series_entity_idx" ON "kernel"."number_series" USING btree ("tenant_id","entity_type","is_active");--> statement-breakpoint
CREATE INDEX "permission_module_idx" ON "kernel"."permission" USING btree ("module_key");--> statement-breakpoint
CREATE INDEX "role_permission_tenant_idx" ON "kernel"."role_permission" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_role_user_idx" ON "kernel"."user_role" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "legal_entity_country_idx" ON "kernel"."legal_entity" USING btree ("tenant_id","country_code");--> statement-breakpoint
CREATE INDEX "tenant_status_idx" ON "kernel"."tenant" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tenant_module_status_idx" ON "kernel"."tenant_module" USING btree ("tenant_id","status");