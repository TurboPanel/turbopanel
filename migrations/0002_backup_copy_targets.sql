CREATE TABLE "backup_copy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"managed_id" uuid NOT NULL,
	"backup_id" text NOT NULL,
	"target_id" uuid,
	"target_name" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"object_key" text,
	"size_bytes" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"copied_at" timestamp(3) with time zone,
	"server_id" uuid,
	CONSTRAINT "backup_copy_backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "backup_copy_state_check" CHECK (state IN ('pending', 'copying', 'copied', 'failed', 'removed')),
	CONSTRAINT "backup_copy_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE "backup_target" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 's3' NOT NULL,
	"endpoint" text NOT NULL,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"is_path_style" boolean DEFAULT true NOT NULL,
	"is_server_side_encrypted" boolean DEFAULT false NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_key_sealed" text NOT NULL,
	"last_tested_at" timestamp(3) with time zone,
	"is_last_test_ok" boolean,
	"last_test_error" text,
	"created_by" uuid,
	CONSTRAINT "backup_target_kind_check" CHECK (kind IN ('s3')),
	CONSTRAINT "backup_target_name_check" CHECK (char_length(name) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "backup_target_assignment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"managed_id" uuid,
	"target_id" uuid,
	CONSTRAINT "backup_target_assignment_target_check" CHECK (managed_id IS NOT NULL OR target_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "backup_copy" ADD CONSTRAINT "backup_copy_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_copy" ADD CONSTRAINT "backup_copy_target_id_backup_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_target"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_copy" ADD CONSTRAINT "backup_copy_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_target" ADD CONSTRAINT "backup_target_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_target" ADD CONSTRAINT "backup_target_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_target_assignment" ADD CONSTRAINT "backup_target_assignment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_target_assignment" ADD CONSTRAINT "backup_target_assignment_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_target_assignment" ADD CONSTRAINT "backup_target_assignment_target_id_backup_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_target"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backup_copy_managed_backup_target" ON "backup_copy" USING btree ("managed_id","backup_id","target_id");--> statement-breakpoint
CREATE INDEX "idx_backup_copy_managed_id_backup_id" ON "backup_copy" USING btree ("managed_id","backup_id");--> statement-breakpoint
CREATE INDEX "idx_backup_copy_target_id" ON "backup_copy" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_backup_copy_server_id" ON "backup_copy" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backup_target_organization_name" ON "backup_target" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_backup_target_created_by" ON "backup_target" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backup_target_assignment_default" ON "backup_target_assignment" USING btree ("organization_id") WHERE managed_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backup_target_assignment_managed" ON "backup_target_assignment" USING btree ("managed_id") WHERE managed_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_backup_target_assignment_target_id" ON "backup_target_assignment" USING btree ("target_id");--> statement-breakpoint
COMMENT ON TABLE "backup_copy" IS 'How copying one backup to one target stands, as the host reported it; keyed by the engine and the daemon''s `bk_` id, cascades with the cluster.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."managed_id" IS 'The cluster whose backup this is.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."backup_id" IS 'The daemon-minted `bk_` id of the backup, matching `backup.backup_id`; kept as text so a report can land first.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."target_id" IS 'Target the copy went to, set null if the target is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."target_name" IS 'Name the target had when the copy was recorded, so a deleted target still reads in plain words.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."state" IS 'One of `pending`, `copying`, `copied`, `failed` or `removed` (pruned from the bucket by retention).';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."error" IS 'A plain reason the copy failed; null otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."object_key" IS 'Object key in the bucket, prefix included; set once the copy is done.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."size_bytes" IS 'Size of the copied object in bytes as the host reported it.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."attempts" IS 'How many times the host tried to copy this backup.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."copied_at" IS 'When the host reported the copy finished; null until then.';--> statement-breakpoint
COMMENT ON COLUMN "backup_copy"."server_id" IS 'The host that reported the latest state, set null if that server is deleted.';--> statement-breakpoint
COMMENT ON TABLE "backup_target" IS 'A named S3-compatible destination an organization copies finished backups to; the secret key is sealed and never returned by an API.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."name" IS 'Label the organization gave the target, unique per organization, 1 to 64 characters.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."kind" IS 'Kind of destination; only `s3` (S3-compatible object storage) for now.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."endpoint" IS 'Base URL of the storage service, for example `https://s3.example.com`; no path.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."region" IS 'Region name used when signing requests; `us-east-1` when the provider has no regions.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."bucket" IS 'Bucket the copies are written to.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."prefix" IS 'Folder inside the bucket, without a leading or trailing slash; empty for the bucket root.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."is_path_style" IS 'True addresses the bucket in the path (`endpoint/bucket/key`); false uses the bucket as a host name prefix.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."is_server_side_encrypted" IS 'True asks the storage to encrypt each object at rest with its own key (`AES256`).';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."access_key_id" IS 'Access key id for the bucket; an identifier, returned by the API.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."secret_key_sealed" IS 'Secret access key sealed with the instance data key (`tpsecret` envelope); never returned by any API.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."last_tested_at" IS 'When the connection test last ran against this target; null before the first test.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."is_last_test_ok" IS 'True when the last connection test passed, false when it failed; null before the first test.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."last_test_error" IS 'A plain reason the last connection test failed; null when it passed or was never run.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target"."created_by" IS 'User who created the target, set null if that user is deleted.';--> statement-breakpoint
COMMENT ON TABLE "backup_target_assignment" IS 'Which backup target applies where: a row with no `managed_id` is the organization''s default, a row with one is that cluster''s own choice.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target_assignment"."managed_id" IS 'The cluster this row overrides the default for; null for the organization default.';--> statement-breakpoint
COMMENT ON COLUMN "backup_target_assignment"."target_id" IS 'Target to copy to; null on a cluster row means no copy for that cluster even when a default exists.';
