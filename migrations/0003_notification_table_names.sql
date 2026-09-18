ALTER TABLE "notification_channel" RENAME TO "channel";--> statement-breakpoint
ALTER TABLE "notification_delivery" RENAME TO "attempt";--> statement-breakpoint
ALTER TABLE "notification_rule" RENAME TO "rule";--> statement-breakpoint
ALTER TABLE "channel" DROP CONSTRAINT "notification_channel_scope_check";--> statement-breakpoint
ALTER TABLE "channel" DROP CONSTRAINT "notification_channel_kind_check";--> statement-breakpoint
ALTER TABLE "channel" DROP CONSTRAINT "notification_channel_owner_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "notification_delivery_event_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "notification_delivery_severity_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "notification_delivery_status_check";--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "notification_rule_event_check";--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "notification_rule_min_severity_check";--> statement-breakpoint
ALTER TABLE "channel" DROP CONSTRAINT "notification_channel_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "channel" DROP CONSTRAINT "notification_channel_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "channel" DROP CONSTRAINT "notification_channel_created_by_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "notification_delivery_channel_id_notification_channel_id_fk";
--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "notification_delivery_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "notification_rule_channel_id_notification_channel_id_fk";
--> statement-breakpoint
DROP INDEX "idx_notification_channel_organization";--> statement-breakpoint
DROP INDEX "idx_notification_channel_user";--> statement-breakpoint
DROP INDEX "idx_notification_delivery_pending";--> statement-breakpoint
DROP INDEX "idx_notification_delivery_channel_created";--> statement-breakpoint
DROP INDEX "uniq_notification_rule_channel_event";--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_organization" ON "channel" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_channel_user" ON "channel" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_attempt_pending" ON "attempt" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_attempt_channel_created" ON "attempt" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_rule_channel_event" ON "rule" USING btree ("channel_id","event");--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_scope_check" CHECK (scope IN ('instance', 'organization', 'user'));--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_kind_check" CHECK (kind IN ('email', 'webhook', 'slack', 'discord', 'telegram', 'push'));--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_owner_check" CHECK ((scope = 'instance' AND organization_id IS NULL AND user_id IS NULL) OR (scope = 'organization' AND organization_id IS NOT NULL AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL AND organization_id IS NULL));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_severity_check" CHECK (severity IN ('info', 'warning', 'critical'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_status_check" CHECK (status IN ('pending', 'sent', 'failed', 'abandoned'));--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_event_check" CHECK (event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked'));--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_min_severity_check" CHECK (min_severity IN ('info', 'warning', 'critical'));