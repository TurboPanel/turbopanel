CREATE TABLE "category" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "category_code_check" CHECK (code ~ '^[a-z][a-z_]{1,39}$')
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"token_hash" text NOT NULL,
	"app_version" text,
	"locale" text,
	"invalid_reason" text,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_device_provider_token_hash" UNIQUE("provider","token_hash"),
	CONSTRAINT "device_kind_check" CHECK (kind IN ('ios', 'android')),
	CONSTRAINT "device_status_check" CHECK (status IN ('active', 'paused', 'invalid')),
	CONSTRAINT "device_provider_check" CHECK (provider IN ('expo'))
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"topic_code" text NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"destination_id" uuid,
	"actor_user_id" uuid,
	"severity" text NOT NULL,
	"dedupe" text,
	"version" integer DEFAULT 1 NOT NULL,
	"repeats" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"fanned_out_at" timestamp(3) with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "event_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "event_status_check" CHECK (status IN ('open', 'resolved', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "policy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"category_code" text,
	"topic_code" text,
	"created_by_user_id" uuid,
	"kind" text,
	"level" text NOT NULL,
	"is_forced" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_policy_scope" UNIQUE NULLS NOT DISTINCT("organization_id","team_id","project_id","environment_id","category_code","topic_code","kind"),
	CONSTRAINT "policy_kind_check" CHECK (kind IS NULL OR kind IN ('inbox', 'email', 'push', 'chat', 'webhook')),
	CONSTRAINT "policy_level_check" CHECK (level IN ('all', 'warning', 'critical', 'none')),
	CONSTRAINT "policy_env_project_check" CHECK (environment_id IS NULL OR project_id IS NOT NULL),
	CONSTRAINT "policy_subject_check" CHECK (num_nonnulls(category_code, topic_code) <= 1)
);
--> statement-breakpoint
CREATE TABLE "preference" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"destination_id" uuid,
	"channel_id" uuid,
	"category_code" text,
	"topic_code" text,
	"ends_at" timestamp(3) with time zone,
	"kind" text,
	"level" text NOT NULL,
	CONSTRAINT "uniq_preference_scope" UNIQUE NULLS NOT DISTINCT("user_id","organization_id","project_id","environment_id","service_id","server_id","destination_id","category_code","topic_code","kind","channel_id"),
	CONSTRAINT "preference_kind_check" CHECK (kind IS NULL OR kind IN ('inbox', 'email', 'push', 'chat', 'webhook')),
	CONSTRAINT "preference_level_check" CHECK (level IN ('all', 'warning', 'critical', 'none')),
	CONSTRAINT "preference_project_org_check" CHECK (project_id IS NULL OR organization_id IS NOT NULL),
	CONSTRAINT "preference_env_project_check" CHECK (environment_id IS NULL OR project_id IS NOT NULL),
	CONSTRAINT "preference_resource_one_check" CHECK (num_nonnulls(service_id, server_id, destination_id) <= 1),
	CONSTRAINT "preference_resource_org_check" CHECK (num_nonnulls(service_id, server_id, destination_id) = 0 OR organization_id IS NOT NULL),
	CONSTRAINT "preference_subject_check" CHECK (num_nonnulls(category_code, topic_code) <= 1),
	CONSTRAINT "preference_target_check" CHECK (num_nonnulls(channel_id, kind) <= 1)
);
--> statement-breakpoint
CREATE TABLE "suppression" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"address_hash" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"cleared_at" timestamp(3) with time zone,
	CONSTRAINT "suppression_reason_check" CHECK (reason IN ('bounced', 'complained', 'rejected')),
	CONSTRAINT "suppression_source_check" CHECK (source IN ('smtp', 'mailgun', 'mailpit', 'manual')),
	CONSTRAINT "suppression_address_hash_check" CHECK (address_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "topic" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"category_code" text NOT NULL,
	"resolves_code" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"scope" text,
	"audience" text NOT NULL,
	"channels" text[] NOT NULL,
	"level" text DEFAULT 'none' NOT NULL,
	"cooldown" interval DEFAULT '00:00:00' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deprecated_at" timestamp(3) with time zone,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"is_actor_notified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "topic_code_check" CHECK (code ~ '^[a-z][a-z_]*[.][a-z][a-z_]*$'),
	CONSTRAINT "topic_kind_check" CHECK (kind IN ('organization', 'platform', 'instance', 'account')),
	CONSTRAINT "topic_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "topic_scope_check" CHECK (scope IS NULL OR scope IN ('organization', 'project', 'environment', 'service', 'server', 'destination')),
	CONSTRAINT "topic_scope_kind_check" CHECK ((kind = 'organization') = (scope IS NOT NULL)),
	CONSTRAINT "topic_audience_check" CHECK (audience IN ('members', 'managers', 'admins')),
	CONSTRAINT "topic_channels_check" CHECK (channels <@ ARRAY['inbox', 'email', 'push', 'chat', 'webhook']::text[]),
	CONSTRAINT "topic_level_check" CHECK (level IN ('all', 'warning', 'critical', 'none'))
);
--> statement-breakpoint
CREATE TABLE "watermark" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid NOT NULL,
	"read_through" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "uniq_watermark_user_organization" UNIQUE NULLS NOT DISTINCT("user_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "uniq_project_organization_id" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "uniq_environment_project_id" UNIQUE("project_id","id");--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_event_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_event_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_status_check";--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "rule_event_check";--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "topic_code" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "destination_id" uuid;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "topic_code" text;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "attempt" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "destination_id" uuid;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "category_code" text;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "topic_code" text;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "ends_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "rule" ADD COLUMN "is_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_all_organizations_notified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_environment_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."environment"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_environment_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."environment"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic" ADD CONSTRAINT "topic_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic" ADD CONSTRAINT "topic_resolves_code_topic_code_fk" FOREIGN KEY ("resolves_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watermark" ADD CONSTRAINT "watermark_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watermark" ADD CONSTRAINT "watermark_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_user_id" ON "device" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_event_open_dedupe" ON "event" USING btree ("dedupe") WHERE status = 'open' AND dedupe IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_event_unfanned" ON "event" USING btree ("created_at") WHERE fanned_out_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_event_created_at" ON "event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_event_organization_id" ON "event" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_event_topic_code" ON "event" USING btree ("topic_code");--> statement-breakpoint
CREATE INDEX "idx_policy_team_id" ON "policy" USING btree ("team_id") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_project_id" ON "policy" USING btree ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_environment_id" ON "policy" USING btree ("environment_id") WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_category_code" ON "policy" USING btree ("category_code") WHERE category_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_topic_code" ON "policy" USING btree ("topic_code") WHERE topic_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_created_by_user_id" ON "policy" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_preference_user_organization" ON "preference" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "idx_preference_organization_id" ON "preference" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_preference_project_id" ON "preference" USING btree ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_environment_id" ON "preference" USING btree ("environment_id") WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_service_id" ON "preference" USING btree ("service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_server_id" ON "preference" USING btree ("server_id") WHERE server_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_destination_id" ON "preference" USING btree ("destination_id") WHERE destination_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_channel_id" ON "preference" USING btree ("channel_id") WHERE channel_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_category_code" ON "preference" USING btree ("category_code") WHERE category_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_topic_code" ON "preference" USING btree ("topic_code") WHERE topic_code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_suppression_active_address" ON "suppression" USING btree ("address_hash") WHERE cleared_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_topic_category_code" ON "topic" USING btree ("category_code");--> statement-breakpoint
CREATE INDEX "idx_topic_resolves_code" ON "topic" USING btree ("resolves_code");--> statement-breakpoint
CREATE INDEX "idx_watermark_organization_id" ON "watermark" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_environment_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."environment"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_created_at" ON "notification" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_topic_code" ON "notification" USING btree ("topic_code");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_channel_primary" ON "channel" USING btree ("user_id","kind") WHERE is_primary;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_attempt_copy" ON "attempt" USING btree ("event_id",coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid),"channel_id",coalesce("device_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_attempt_event_id" ON "attempt" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_attempt_user_id" ON "attempt" USING btree ("user_id") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_attempt_device_id" ON "attempt" USING btree ("device_id") WHERE device_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_attempt_topic_code" ON "attempt" USING btree ("topic_code");--> statement-breakpoint
CREATE INDEX "idx_attempt_created_at" ON "attempt" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_rule_organization_id" ON "rule" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_rule_project_id" ON "rule" USING btree ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_environment_id" ON "rule" USING btree ("environment_id") WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_service_id" ON "rule" USING btree ("service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_server_id" ON "rule" USING btree ("server_id") WHERE server_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_destination_id" ON "rule" USING btree ("destination_id") WHERE destination_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_category_code" ON "rule" USING btree ("category_code") WHERE category_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_topic_code" ON "rule" USING btree ("topic_code") WHERE topic_code IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "uniq_notification_event_user" UNIQUE("event_id","user_id");--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_paused_reason_check" CHECK (paused_reason IS NULL OR paused_reason IN ('manual', 'failing', 'bounced'));--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_primary_check" CHECK (NOT is_primary OR (scope = 'user' AND kind = 'email'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_reason_check" CHECK (reason IS NULL OR reason IN ('quiet_hours', 'digest', 'muted', 'rate_limited', 'bounced', 'no_access', 'scope_deleted', 'read_in_app', 'unverified', 'channel_failing'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_status_check" CHECK (status IN ('pending', 'sent', 'failed', 'abandoned', 'held', 'suppressed'));--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_project_org_check" CHECK (project_id IS NULL OR organization_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_env_project_check" CHECK (environment_id IS NULL OR project_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_resource_one_check" CHECK (num_nonnulls(service_id, server_id, destination_id) <= 1);--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_resource_org_check" CHECK (num_nonnulls(service_id, server_id, destination_id) = 0 OR organization_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_subject_check" CHECK (num_nonnulls(category_code, topic_code) <= 1);--> statement-breakpoint
COMMENT ON COLUMN "notification"."event_id" IS 'The `event` row this copy came from, a plain id with no foreign key so the 90-day inbox outlives the 30-day event retention.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."topic_code" IS 'The catalogue topic, written beside the older `event` column.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."project_id" IS 'Project the event was about, a plain id with no foreign key so the row outlives the project; used for links and filters.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."environment_id" IS 'Environment the event was about, a plain id with no foreign key so the row outlives the environment.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."service_id" IS 'Service the event was about, a plain id with no foreign key so the row outlives the service.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."server_id" IS 'Server the event was about, a plain id with no foreign key so the row outlives the server.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."destination_id" IS 'Backup target the event was about, a plain id with no foreign key so the row outlives the target.';--> statement-breakpoint
COMMENT ON TABLE "category" IS 'A group of notification topics for the settings screens, written from the code catalogue by the catalog sync in migrate and never deleted.';--> statement-breakpoint
COMMENT ON COLUMN "category"."code" IS 'Permanent key such as `servers` or `security`; a code is never reused with a new meaning.';--> statement-breakpoint
COMMENT ON COLUMN "category"."name" IS 'Group name shown on the settings screens, in book title case.';--> statement-breakpoint
COMMENT ON COLUMN "category"."position" IS 'Sort order on the settings screens, smallest first.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."failures" IS 'Consecutive failed sends, reset by a success; reserved for pausing a failing shared channel.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."paused_reason" IS 'Why sending stopped: `manual`, `failing` or `bounced`; NULL while the channel sends.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."is_primary" IS 'True for a person''s built-in account email channel, which follows their sign-in address and cannot be deleted; one per person.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."event_id" IS 'The `event` row this copy carries; deleting the event at the end of its 30-day retention deletes its copies. NULL on rows written before it existed.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."user_id" IS 'The person a personal copy is for, checked again for access before it is sent; NULL for an organization or instance channel.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."device_id" IS 'The device a push copy goes to; NULL for every other kind (push is not sent yet).';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."topic_code" IS 'The catalogue topic of the event, written beside the older `event` column.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."reason" IS 'Why the copy was held or not sent: `quiet_hours`, `digest`, `no_access`, `scope_deleted`, `read_in_app`, `unverified`, `bounced` and others; NULL when sent.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."provider_id" IS 'Id the mail queue or push service gave the send, when it gives one; NULL otherwise.';--> statement-breakpoint
COMMENT ON TABLE "device" IS 'A phone or tablet that can receive push notifications for one person; the table is in place before the push transport, and nothing writes it yet.';--> statement-breakpoint
COMMENT ON COLUMN "device"."name" IS 'What the person calls the device.';--> statement-breakpoint
COMMENT ON COLUMN "device"."kind" IS '`ios` or `android`.';--> statement-breakpoint
COMMENT ON COLUMN "device"."status" IS '`active` (default), `paused` by the person, or `invalid` once the push service refused the token.';--> statement-breakpoint
COMMENT ON COLUMN "device"."provider" IS 'Push service the token belongs to; `expo` only for now.';--> statement-breakpoint
COMMENT ON COLUMN "device"."token" IS 'Sealed `tpsecret` push token.';--> statement-breakpoint
COMMENT ON COLUMN "device"."token_hash" IS 'SHA-256 of the plain token, unique per provider, so one token belongs to one row although the sealed value varies.';--> statement-breakpoint
COMMENT ON COLUMN "device"."app_version" IS 'App version the device last registered with.';--> statement-breakpoint
COMMENT ON COLUMN "device"."locale" IS 'Language tag the device last registered with.';--> statement-breakpoint
COMMENT ON COLUMN "device"."invalid_reason" IS 'Short error code the push service gave when it refused the token; NULL while the token works.';--> statement-breakpoint
COMMENT ON COLUMN "device"."last_seen_at" IS 'When the app last registered the device; old tokens are retired by a sweep.';--> statement-breakpoint
COMMENT ON TABLE "event" IS 'One row per thing that happened, the outbox every inbox row and delivery hangs from; scope ids are plain uuids so deletes never touch history.';--> statement-breakpoint
COMMENT ON COLUMN "event"."organization_id" IS 'Organization the event was raised in; NULL for an instance or platform event.';--> statement-breakpoint
COMMENT ON COLUMN "event"."topic_code" IS 'The catalogue topic.';--> statement-breakpoint
COMMENT ON COLUMN "event"."project_id" IS 'Project the event is about, a plain id with no foreign key; a pending copy is dropped once the project is gone.';--> statement-breakpoint
COMMENT ON COLUMN "event"."environment_id" IS 'Environment the event is about, a plain id with no foreign key; a pending copy is dropped once it is gone.';--> statement-breakpoint
COMMENT ON COLUMN "event"."service_id" IS 'Service the event is about, a plain id with no foreign key; a pending copy is dropped once it is gone.';--> statement-breakpoint
COMMENT ON COLUMN "event"."server_id" IS 'Server the event is about, a plain id with no foreign key; a pending copy is dropped once it is gone.';--> statement-breakpoint
COMMENT ON COLUMN "event"."destination_id" IS 'Backup target the event is about, a plain id with no foreign key; a pending copy is dropped once it is gone.';--> statement-breakpoint
COMMENT ON COLUMN "event"."actor_user_id" IS 'Who caused the event, a plain id like `audit.actor_user_id`; that person is not told unless the topic says so.';--> statement-breakpoint
COMMENT ON COLUMN "event"."severity" IS '`info`, `warning` or `critical`, copied from the topic when the event was raised.';--> statement-breakpoint
COMMENT ON COLUMN "event"."dedupe" IS 'Key that folds repeats of an open event inside the topic cooldown into one row; NULL means every occurrence is its own event.';--> statement-breakpoint
COMMENT ON COLUMN "event"."version" IS 'Payload version, the topic version when the event was raised.';--> statement-breakpoint
COMMENT ON COLUMN "event"."repeats" IS 'How many repeats were folded into this event inside the cooldown.';--> statement-breakpoint
COMMENT ON COLUMN "event"."last_seen_at" IS 'When the event, or its latest folded repeat, happened.';--> statement-breakpoint
COMMENT ON COLUMN "event"."fanned_out_at" IS 'When its inbox rows and deliveries were written; NULL while that is still to do.';--> statement-breakpoint
COMMENT ON COLUMN "event"."status" IS '`open`, `resolved` (its recovery event arrived) or `closed`.';--> statement-breakpoint
COMMENT ON COLUMN "event"."data" IS 'Small non-secret context the sentences render from, with resource names snapshotted so a deleted resource still reads in words.';--> statement-breakpoint
COMMENT ON TABLE "policy" IS 'An organization''s default notification level for its members or one team, optionally locked; the data model is in place, the screens come later.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."team_id" IS 'Team the default is for; NULL means every member.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."project_id" IS 'Project the default is for; a composite key with `organization_id` proves the project is in that organization, and deleting it deletes the row.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."environment_id" IS 'Environment the default is for; a composite key with `project_id` proves it is in that project, and deleting it deletes the row.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."category_code" IS 'Catalogue category the default is for; NULL with `topic_code` NULL means every topic.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."topic_code" IS 'One catalogue topic the default is for.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."created_by_user_id" IS 'Who set the default; NULL once that account is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."kind" IS 'Channel kind the default is for: `inbox`, `email`, `push`, `chat` or `webhook`; NULL means every kind.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."level" IS '`all`, `warning`, `critical` or `none`.';--> statement-breakpoint
COMMENT ON COLUMN "policy"."is_forced" IS 'True means members cannot override the default.';--> statement-breakpoint
COMMENT ON TABLE "preference" IS 'One person''s notification level for one scope, channel and subject; sparse, most specific row wins, and no row at all means nothing is sent.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."organization_id" IS 'Organization the choice is for; NULL means every organization the person belongs to and the install events.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."project_id" IS 'Project the choice is for; a composite key with `organization_id` proves the project is in that organization, and deleting it deletes the row.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."environment_id" IS 'Environment the choice is for; a composite key with `project_id` proves it is in that project, and deleting it deletes the row.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."service_id" IS 'Service the choice is for; deleting the service deletes the row.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."server_id" IS 'Server the choice is for; deleting the server deletes the row.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."destination_id" IS 'Backup target the choice is for; deleting the target deletes the row.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."channel_id" IS 'One personal channel the choice is for; NULL with `kind` NULL means every channel.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."category_code" IS 'Catalogue category the choice is for; NULL with `topic_code` NULL means every topic.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."topic_code" IS 'One catalogue topic the choice is for.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."ends_at" IS 'A temporary mute or watch: the row stops applying at this time; NULL means it lasts.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."kind" IS 'Channel kind the choice is for: `inbox`, `email`, `push`, `chat` (Slack, Discord, Telegram) or `webhook`; NULL means every kind.';--> statement-breakpoint
COMMENT ON COLUMN "preference"."level" IS '`all`, `warning` (warnings and critical), `critical` or `none`.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."organization_id" IS 'Organization a shared route belongs to, set with the scope columns that narrow it; NULL on routes written before scoped routes.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."project_id" IS 'Project the route is limited to; deleting the project deletes the route.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."environment_id" IS 'Environment the route is limited to; deleting the environment deletes the route.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."service_id" IS 'Service the route is limited to; deleting the service deletes the route.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."server_id" IS 'Server the route is limited to; deleting the server deletes the route.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."destination_id" IS 'Backup target the route is limited to; deleting the target deletes the route.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."category_code" IS 'Catalogue category the route is limited to; NULL with `topic_code` NULL means every topic.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."topic_code" IS 'One catalogue topic the route is limited to; NULL means the `event` column or the category decides.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."ends_at" IS 'A muted route sends nothing until this time; NULL means not muted.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."is_enabled" IS 'False keeps the route and sends nothing through it.';--> statement-breakpoint
COMMENT ON TABLE "suppression" IS 'An email address no notification is sent to because it bounced or was refused, keyed by a hash so the address is never stored here.';--> statement-breakpoint
COMMENT ON COLUMN "suppression"."address_hash" IS 'SHA-256 hex of the trimmed, lower-cased address; one active row per address.';--> statement-breakpoint
COMMENT ON COLUMN "suppression"."reason" IS '`bounced`, `complained` or `rejected` (the provider refused the recipient for good).';--> statement-breakpoint
COMMENT ON COLUMN "suppression"."source" IS 'Mail path that reported it: `smtp`, `mailgun`, `mailpit` or `manual`.';--> statement-breakpoint
COMMENT ON COLUMN "suppression"."cleared_at" IS 'When the address was confirmed again; NULL while it is suppressed.';--> statement-breakpoint
COMMENT ON TABLE "topic" IS 'One row per notification event type, upserted from `events.ts` by the catalog sync in migrate; a code that leaves the code base gets `deprecated_at`.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."code" IS 'Permanent event code such as `server.offline`; preferences, events and history name it, so it is never reused.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."category_code" IS 'The `category` the topic is listed under.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."resolves_code" IS 'The topic this one resolves, such as a recovery naming the failure it ends; NULL for most topics.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."name" IS 'What a person picks the topic by on the settings screens.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."kind" IS '`organization` (raised in an organization), `platform` (vendor notices), `instance` (for administrators) or `account` (one sign-in).';--> statement-breakpoint
COMMENT ON COLUMN "topic"."severity" IS '`info`, `warning` or `critical`; a preference level is a floor compared against it.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."scope" IS 'For an organization topic, the most specific resource it names: `organization`, `project`, `environment`, `service`, `server` or `destination`.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."audience" IS 'Who may hear it, checked again at send time: `members` of the organization, its `managers` (own or manage grants), or `admins` of the install.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."channels" IS 'Channel kinds the topic may use, a subset of `inbox`, `email`, `push`, `chat` and `webhook`.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."level" IS 'Level used when no preference applies; `none` for every topic, so nothing arrives until a person turns it on.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."cooldown" IS 'How long a repeat of an open event with the same dedupe key is folded into it rather than sent again; zero means never.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."version" IS 'Version of the payload shape in `event.data`.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."deprecated_at" IS 'When the code left the code base; old rows keep naming it and no new events use it.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."is_urgent" IS 'True when quiet hours and digests never hold it; this is timing only, a person can still turn it off.';--> statement-breakpoint
COMMENT ON COLUMN "topic"."is_actor_notified" IS 'False means the person who caused the event is never told about it.';--> statement-breakpoint
COMMENT ON TABLE "watermark" IS 'Mark-all-read without rewriting rows: one per person and organization, and inbox rows created at or before `read_through` read as read.';--> statement-breakpoint
COMMENT ON COLUMN "watermark"."organization_id" IS 'Organization the mark covers; NULL means every organization and the install events.';--> statement-breakpoint
COMMENT ON COLUMN "watermark"."read_through" IS 'Inbox rows created at or before this time read as read.';--> statement-breakpoint
COMMENT ON COLUMN "user"."is_all_organizations_notified" IS 'An administrator chose to hear every organization, not only those they belong to; their own preferences still decide what arrives.';
