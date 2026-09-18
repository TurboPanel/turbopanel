CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"event" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"target_type" text,
	"target_id" uuid,
	"context" jsonb,
	"read_at" timestamp(3) with time zone,
	"dismissed_at" timestamp(3) with time zone,
	CONSTRAINT "notification_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked')),
	CONSTRAINT "notification_severity_check" CHECK (severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "notification_channel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"scope" text NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"signing_secret" text,
	"verified_at" timestamp(3) with time zone,
	"disabled_at" timestamp(3) with time zone,
	"created_by_user_id" uuid,
	CONSTRAINT "notification_channel_scope_check" CHECK (scope IN ('instance', 'organization', 'user')),
	CONSTRAINT "notification_channel_kind_check" CHECK (kind IN ('email', 'webhook', 'slack', 'discord', 'telegram', 'push')),
	CONSTRAINT "notification_channel_owner_check" CHECK ((scope = 'instance' AND organization_id IS NULL AND user_id IS NULL) OR (scope = 'organization' AND organization_id IS NOT NULL AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL AND organization_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"channel_id" uuid NOT NULL,
	"organization_id" uuid,
	"event" text NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp(3) with time zone,
	"sent_at" timestamp(3) with time zone,
	"last_error" text,
	CONSTRAINT "notification_delivery_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked')),
	CONSTRAINT "notification_delivery_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "notification_delivery_status_check" CHECK (status IN ('pending', 'sent', 'failed', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "notification_rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"channel_id" uuid NOT NULL,
	"event" text NOT NULL,
	"min_severity" text DEFAULT 'info' NOT NULL,
	CONSTRAINT "notification_rule_event_check" CHECK (event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked')),
	CONSTRAINT "notification_rule_min_severity_check" CHECK (min_severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_channel_id_notification_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rule" ADD CONSTRAINT "notification_rule_channel_id_notification_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_user_created" ON "notification" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notification_channel_organization" ON "notification_channel" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_notification_channel_user" ON "notification_channel" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_pending" ON "notification_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_channel_created" ON "notification_delivery" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_notification_rule_channel_event" ON "notification_rule" USING btree ("channel_id","event");