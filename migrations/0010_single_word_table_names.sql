ALTER TABLE "volumebackup" RENAME TO "archive";--> statement-breakpoint
ALTER TABLE "backuppolicy" RENAME TO "retention";--> statement-breakpoint
ALTER TABLE "backuprun" RENAME TO "snapshot";--> statement-breakpoint
ALTER TABLE "backup" RENAME COLUMN "policy_id" TO "retention_id";--> statement-breakpoint
ALTER TABLE "snapshot" RENAME COLUMN "policy_id" TO "retention_id";--> statement-breakpoint
ALTER TABLE "archive" RENAME COLUMN "policy_id" TO "retention_id";--> statement-breakpoint
ALTER TABLE "retention" DROP CONSTRAINT "backuppolicy_target_kind_check";--> statement-breakpoint
ALTER TABLE "retention" DROP CONSTRAINT "backuppolicy_target_check";--> statement-breakpoint
ALTER TABLE "retention" DROP CONSTRAINT "backuppolicy_retention_keep_check";--> statement-breakpoint
ALTER TABLE "snapshot" DROP CONSTRAINT "backuprun_run_id_format_check";--> statement-breakpoint
ALTER TABLE "snapshot" DROP CONSTRAINT "backuprun_status_check";--> statement-breakpoint
ALTER TABLE "snapshot" DROP CONSTRAINT "backuprun_backup_ref_format_check";--> statement-breakpoint
ALTER TABLE "archive" DROP CONSTRAINT "volumebackup_backup_id_format_check";--> statement-breakpoint
ALTER TABLE "archive" DROP CONSTRAINT "volumebackup_checksum_format_check";--> statement-breakpoint
ALTER TABLE "archive" DROP CONSTRAINT "volumebackup_size_bytes_check";--> statement-breakpoint
ALTER TABLE "backup" DROP CONSTRAINT "backup_policy_id_backuppolicy_id_fk";
--> statement-breakpoint
ALTER TABLE "retention" DROP CONSTRAINT "backuppolicy_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "retention" DROP CONSTRAINT "backuppolicy_managed_id_managed_id_fk";
--> statement-breakpoint
ALTER TABLE "retention" DROP CONSTRAINT "backuppolicy_copy_id_copy_id_fk";
--> statement-breakpoint
ALTER TABLE "retention" DROP CONSTRAINT "backuppolicy_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "snapshot" DROP CONSTRAINT "backuprun_policy_id_backuppolicy_id_fk";
--> statement-breakpoint
ALTER TABLE "snapshot" DROP CONSTRAINT "backuprun_server_id_server_id_fk";
--> statement-breakpoint
ALTER TABLE "archive" DROP CONSTRAINT "volumebackup_copy_id_copy_id_fk";
--> statement-breakpoint
ALTER TABLE "archive" DROP CONSTRAINT "volumebackup_policy_id_backuppolicy_id_fk";
--> statement-breakpoint
DROP INDEX "idx_backup_policy_id";--> statement-breakpoint
DROP INDEX "idx_backuppolicy_organization_id";--> statement-breakpoint
DROP INDEX "idx_backuppolicy_managed_id";--> statement-breakpoint
DROP INDEX "idx_backuppolicy_copy_id";--> statement-breakpoint
DROP INDEX "idx_backuprun_policy_id_started_at";--> statement-breakpoint
DROP INDEX "idx_backuprun_server_id";--> statement-breakpoint
DROP INDEX "uniq_backuprun_policy_run_id";--> statement-breakpoint
DROP INDEX "idx_volumebackup_copy_id_created_at";--> statement-breakpoint
DROP INDEX "idx_volumebackup_policy_id";--> statement-breakpoint
DROP INDEX "uniq_volumebackup_copy_backup_id";--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_retention_id_retention_id_fk" FOREIGN KEY ("retention_id") REFERENCES "public"."retention"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_copy_id_copy_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_retention_id_retention_id_fk" FOREIGN KEY ("retention_id") REFERENCES "public"."retention"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_copy_id_copy_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_retention_id_retention_id_fk" FOREIGN KEY ("retention_id") REFERENCES "public"."retention"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_backup_retention_id" ON "backup" USING btree ("retention_id");--> statement-breakpoint
CREATE INDEX "idx_retention_organization_id" ON "retention" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_retention_managed_id" ON "retention" USING btree ("managed_id");--> statement-breakpoint
CREATE INDEX "idx_retention_copy_id" ON "retention" USING btree ("copy_id");--> statement-breakpoint
CREATE INDEX "idx_snapshot_retention_id_started_at" ON "snapshot" USING btree ("retention_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_snapshot_server_id" ON "snapshot" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_snapshot_retention_run_id" ON "snapshot" USING btree ("retention_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_archive_copy_id_created_at" ON "archive" USING btree ("copy_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_archive_retention_id" ON "archive" USING btree ("retention_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_archive_copy_backup_id" ON "archive" USING btree ("copy_id","backup_id");--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_target_kind_check" CHECK (target_kind IN ('managed', 'copy'));--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_target_check" CHECK ((target_kind = 'managed' AND managed_id IS NOT NULL AND copy_id IS NULL) OR (target_kind = 'copy' AND copy_id IS NOT NULL AND managed_id IS NULL));--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_retention_keep_check" CHECK (retention_keep BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_run_id_format_check" CHECK (run_id ~ '^[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_status_check" CHECK (status IN ('succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_backup_ref_format_check" CHECK (backup_ref IS NULL OR backup_ref ~ '^[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_checksum_format_check" CHECK (checksum ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_size_bytes_check" CHECK (size_bytes >= 0);
--> statement-breakpoint
COMMENT ON TABLE "archive" IS 'One completed storage-copy backup artifact recorded from a daemon report; unique per (copy_id, backup_id), cascades with the copy.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."retention_id" IS 'The `retention` whose scheduled run made this artifact; null for a manual backup or once that retention is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."backup_id" IS 'Daemon-minted `bk_` plus hex token that is also the artifact filename on the host; unique per storage copy, not globally.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."size_bytes" IS 'Artifact size in bytes as reported by the daemon after writing the archive; re-checked before a restore.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."checksum" IS 'Lowercase SHA-256 hex digest of the artifact computed by the daemon; a restore refuses on mismatch.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."path" IS 'Absolute artifact path on the copy''s server as reported by the daemon.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."retention_id" IS 'The `retention` whose scheduled run made this artifact; null for a manual backup or once that retention is deleted.';--> statement-breakpoint
COMMENT ON TABLE "retention" IS 'A scheduled backup of one managed engine or one local storage copy, pushed to its host as a systemd timer that runs without the control plane.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."organization_id" IS 'Owning organization stored directly, because the target is polymorphic; cascade-deletes the policy with the org.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."target_kind" IS '`managed` or `copy`: which of `managed_id` and `copy_id` names the target; exactly one is set (`retention_target_check`).';--> statement-breakpoint
COMMENT ON COLUMN "retention"."name" IS 'Operator label for the policy, shown in the console''s backup list.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."schedule" IS 'The schedule as authored, a cron expression or alias; translated to a systemd `OnCalendar` value when pushed to the host.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."timezone" IS 'IANA zone the schedule is read in; null means the host''s local time.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."retention_keep" IS 'How many of this policy''s own artifacts the host keeps, 1 to 100; older ones are pruned after each run.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."is_enabled" IS 'False pauses the policy: its timer is removed from the host while the row and its run history stay.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."next_run_at" IS 'When the host''s timer next fires, as last reported by the daemon; null until a report arrives.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."created_by" IS 'User who created the policy; null for an automatic default policy or once that user is deleted.';--> statement-breakpoint
COMMENT ON TABLE "snapshot" IS 'One finished scheduled run of a `retention`, reported by the host that ran it; unique per (retention_id, run_id).';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."retention_id" IS 'The `retention` this run belongs to; the run history cascades with it.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."run_id" IS 'Daemon-minted id for the run, unique per policy so a report delivered twice is recorded once.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."started_at" IS 'When the host started the run.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."finished_at" IS 'When the host finished the run, whether it succeeded or failed.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."status" IS '`succeeded` or `failed`, as reported by the host.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."error" IS 'Failure text reported by the host; null when the run succeeded.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."backup_ref" IS 'The `bk_` id of the artifact the run produced, matching `backup.backup_id` or `archive.backup_id`; null when it failed.';
