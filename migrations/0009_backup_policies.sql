CREATE TABLE "backuppolicy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"managed_id" uuid,
	"copy_id" uuid,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text,
	"retention_keep" integer NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp(3) with time zone,
	"created_by" uuid,
	CONSTRAINT "backuppolicy_target_kind_check" CHECK (target_kind IN ('managed', 'copy')),
	CONSTRAINT "backuppolicy_target_check" CHECK ((target_kind = 'managed' AND managed_id IS NOT NULL AND copy_id IS NULL) OR (target_kind = 'copy' AND copy_id IS NOT NULL AND managed_id IS NULL)),
	CONSTRAINT "backuppolicy_retention_keep_check" CHECK (retention_keep BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "backuprun" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"policy_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"started_at" timestamp(3) with time zone NOT NULL,
	"finished_at" timestamp(3) with time zone NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"backup_ref" text,
	CONSTRAINT "backuprun_run_id_format_check" CHECK (run_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "backuprun_status_check" CHECK (status IN ('succeeded', 'failed')),
	CONSTRAINT "backuprun_backup_ref_format_check" CHECK (backup_ref IS NULL OR backup_ref ~ '^[A-Za-z0-9_-]+$')
);
--> statement-breakpoint
CREATE TABLE "volumebackup" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"copy_id" uuid NOT NULL,
	"policy_id" uuid,
	"backup_id" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "volumebackup_backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "volumebackup_checksum_format_check" CHECK (checksum ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "volumebackup_size_bytes_check" CHECK (size_bytes >= 0)
);
--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "policy_id" uuid;--> statement-breakpoint
ALTER TABLE "backuppolicy" ADD CONSTRAINT "backuppolicy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backuppolicy" ADD CONSTRAINT "backuppolicy_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backuppolicy" ADD CONSTRAINT "backuppolicy_copy_id_copy_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backuppolicy" ADD CONSTRAINT "backuppolicy_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backuprun" ADD CONSTRAINT "backuprun_policy_id_backuppolicy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backuppolicy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backuprun" ADD CONSTRAINT "backuprun_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volumebackup" ADD CONSTRAINT "volumebackup_copy_id_copy_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volumebackup" ADD CONSTRAINT "volumebackup_policy_id_backuppolicy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backuppolicy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_backuppolicy_organization_id" ON "backuppolicy" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_backuppolicy_managed_id" ON "backuppolicy" USING btree ("managed_id");--> statement-breakpoint
CREATE INDEX "idx_backuppolicy_copy_id" ON "backuppolicy" USING btree ("copy_id");--> statement-breakpoint
CREATE INDEX "idx_backuprun_policy_id_started_at" ON "backuprun" USING btree ("policy_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_backuprun_server_id" ON "backuprun" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backuprun_policy_run_id" ON "backuprun" USING btree ("policy_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_volumebackup_copy_id_created_at" ON "volumebackup" USING btree ("copy_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_volumebackup_policy_id" ON "volumebackup" USING btree ("policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_volumebackup_copy_backup_id" ON "volumebackup" USING btree ("copy_id","backup_id");--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_policy_id_backuppolicy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backuppolicy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_backup_policy_id" ON "backup" USING btree ("policy_id");
--> statement-breakpoint
COMMENT ON COLUMN "backup"."policy_id" IS 'The `backuppolicy` whose scheduled run made this artifact; null for a manual backup or once that policy is deleted.';--> statement-breakpoint
COMMENT ON TABLE "backuppolicy" IS 'A scheduled backup of one managed engine or one local storage copy, pushed to its host as a systemd timer that runs without the control plane.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."organization_id" IS 'Owning organization stored directly, because the target is polymorphic; cascade-deletes the policy with the org.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."target_kind" IS '`managed` or `copy`: which of `managed_id` and `copy_id` names the target; exactly one is set (`backuppolicy_target_check`).';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."name" IS 'Operator label for the policy, shown in the console''s backup list.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."schedule" IS 'The schedule as authored, a cron expression or alias; translated to a systemd `OnCalendar` value when pushed to the host.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."timezone" IS 'IANA zone the schedule is read in; null means the host''s local time.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."retention_keep" IS 'How many of this policy''s own artifacts the host keeps, 1 to 100; older ones are pruned after each run.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."is_enabled" IS 'False pauses the policy: its timer is removed from the host while the row and its run history stay.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."next_run_at" IS 'When the host''s timer next fires, as last reported by the daemon; null until a report arrives.';--> statement-breakpoint
COMMENT ON COLUMN "backuppolicy"."created_by" IS 'User who created the policy; null for an automatic default policy or once that user is deleted.';--> statement-breakpoint
COMMENT ON TABLE "backuprun" IS 'One finished scheduled run of a backup policy, reported by the host that ran it; unique per (policy_id, run_id).';--> statement-breakpoint
COMMENT ON COLUMN "backuprun"."policy_id" IS 'The `backuppolicy` this run belongs to; the run history cascades with the policy.';--> statement-breakpoint
COMMENT ON COLUMN "backuprun"."run_id" IS 'Daemon-minted id for the run, unique per policy so a report delivered twice is recorded once.';--> statement-breakpoint
COMMENT ON COLUMN "backuprun"."started_at" IS 'When the host started the run.';--> statement-breakpoint
COMMENT ON COLUMN "backuprun"."finished_at" IS 'When the host finished the run, whether it succeeded or failed.';--> statement-breakpoint
COMMENT ON COLUMN "backuprun"."status" IS '`succeeded` or `failed`, as reported by the host.';--> statement-breakpoint
COMMENT ON COLUMN "backuprun"."error" IS 'Failure text reported by the host; null when the run succeeded.';--> statement-breakpoint
COMMENT ON COLUMN "backuprun"."backup_ref" IS 'The `bk_` id of the artifact the run produced, matching `backup.backup_id` or `volumebackup.backup_id`; null when it failed.';--> statement-breakpoint
COMMENT ON TABLE "volumebackup" IS 'One completed storage-copy backup artifact recorded from a daemon report; unique per (copy_id, backup_id), cascades with the copy.';--> statement-breakpoint
COMMENT ON COLUMN "volumebackup"."policy_id" IS 'The `backuppolicy` whose scheduled run made this artifact; null for a manual backup or once that policy is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "volumebackup"."backup_id" IS 'Daemon-minted `bk_` plus hex token that is also the artifact filename on the host; unique per storage copy, not globally.';--> statement-breakpoint
COMMENT ON COLUMN "volumebackup"."size_bytes" IS 'Artifact size in bytes as reported by the daemon after writing the archive; re-checked before a restore.';--> statement-breakpoint
COMMENT ON COLUMN "volumebackup"."checksum" IS 'Lowercase SHA-256 hex digest of the artifact computed by the daemon; a restore refuses on mismatch.';--> statement-breakpoint
COMMENT ON COLUMN "volumebackup"."path" IS 'Absolute artifact path on the copy''s server as reported by the daemon.';
