ALTER TABLE "notification" DROP CONSTRAINT "notification_event_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_event_check";--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "rule_event_check";--> statement-breakpoint
ALTER TABLE "folder" ADD COLUMN "orphan_alerted_at" timestamp(3) with time zone;--> statement-breakpoint
CREATE INDEX "idx_folder_orphan_unalerted" ON "folder" USING btree ("server_id" uuid_ops) WHERE "folder"."state" = 'orphan' AND "folder"."orphan_alerted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_folder_orphan_alerted" ON "folder" USING btree ("state" text_ops) WHERE "folder"."orphan_alerted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found'));--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_event_check" CHECK (event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found'));--> statement-breakpoint
COMMENT ON COLUMN "notification"."event" IS 'Catalogue code (`NOTIFICATION_EVENTS`): `server.offline`, `fleet.mass_disconnect`, `server.deleted`, `server.daemon_key_revoked`, `access.grant_*`, `certificate.renewal_failed`, `folder.orphans_found`.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."orphan_alerted_at" IS 'When the organization was told this folder is an orphan, so one orphan sends one alert; NULL until then, and cleared again once the folder stops being an orphan.';--> statement-breakpoint
UPDATE "folder" SET "orphan_alerted_at" = now() WHERE "state" = 'orphan';
