CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TABLE "platform"."operator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text NOT NULL,
	"totp_confirmed_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "platform"."operator_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"operator_email" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" varchar(64) NOT NULL,
	"tenant_id" uuid,
	"tenant_slug" text,
	"tenant_count" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" "inet",
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "platform"."operator_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "platform"."operator_session" ADD CONSTRAINT "operator_session_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "platform"."operator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_email_idx" ON "platform"."operator" USING btree ("email");--> statement-breakpoint
CREATE INDEX "operator_action_operator_idx" ON "platform"."operator_action" USING btree ("operator_id","occurred_at");--> statement-breakpoint
CREATE INDEX "operator_action_tenant_idx" ON "platform"."operator_action" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "operator_action_time_idx" ON "platform"."operator_action" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "operator_session_operator_idx" ON "platform"."operator_session" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_session_expiry_idx" ON "platform"."operator_session" USING btree ("expires_at");