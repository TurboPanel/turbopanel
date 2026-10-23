CREATE TABLE "mirror" (
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
	CONSTRAINT "mirror_backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "mirror_state_check" CHECK (state IN ('pending', 'copying', 'copied', 'failed', 'removed')),
	CONSTRAINT "mirror_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE "destination" (
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
	CONSTRAINT "destination_kind_check" CHECK (kind IN ('s3')),
	CONSTRAINT "destination_name_check" CHECK (char_length(name) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "selection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"managed_id" uuid,
	"target_id" uuid,
	CONSTRAINT "selection_target_check" CHECK (managed_id IS NOT NULL OR target_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "mirror" ADD CONSTRAINT "mirror_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror" ADD CONSTRAINT "mirror_target_id_destination_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."destination"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror" ADD CONSTRAINT "mirror_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_target_id_destination_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."destination"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mirror_managed_destination" ON "mirror" USING btree ("managed_id","backup_id","target_id");--> statement-breakpoint
CREATE INDEX "idx_mirror_managed_id_backup_id" ON "mirror" USING btree ("managed_id","backup_id");--> statement-breakpoint
CREATE INDEX "idx_mirror_target_id" ON "mirror" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_mirror_server_id" ON "mirror" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_destination_organization_name" ON "destination" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_destination_created_by" ON "destination" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_selection_default" ON "selection" USING btree ("organization_id") WHERE managed_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_selection_managed" ON "selection" USING btree ("managed_id") WHERE managed_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_selection_target_id" ON "selection" USING btree ("target_id");--> statement-breakpoint
COMMENT ON TABLE "mirror" IS 'How copying one backup to one target stands, as the host reported it; keyed by the engine and the daemon''s `bk_` id, cascades with the cluster.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."managed_id" IS 'The cluster whose backup this is.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."backup_id" IS 'The daemon-minted `bk_` id of the backup, matching `backup.backup_id`; kept as text so a report can land first.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."target_id" IS 'Target the copy went to, set null if the target is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."target_name" IS 'Name the target had when the copy was recorded, so a deleted target still reads in plain words.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."state" IS 'One of `pending`, `copying`, `copied`, `failed` or `removed` (pruned from the bucket by retention).';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."error" IS 'A plain reason the copy failed; null otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."object_key" IS 'Object key in the bucket, prefix included; set once the copy is done.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."size_bytes" IS 'Size of the copied object in bytes as the host reported it.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."attempts" IS 'How many times the host tried to copy this backup.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."copied_at" IS 'When the host reported the copy finished; null until then.';--> statement-breakpoint
COMMENT ON COLUMN "mirror"."server_id" IS 'The host that reported the latest state, set null if that server is deleted.';--> statement-breakpoint
COMMENT ON TABLE "destination" IS 'A named S3-compatible destination an organization copies finished backups to; the secret key is sealed and never returned by an API.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."name" IS 'Label the organization gave the target, unique per organization, 1 to 64 characters.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."kind" IS 'Kind of destination; only `s3` (S3-compatible object storage) for now.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."endpoint" IS 'Base URL of the storage service, for example `https://s3.example.com`; no path.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."region" IS 'Region name used when signing requests; `us-east-1` when the provider has no regions.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."bucket" IS 'Bucket the copies are written to.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."prefix" IS 'Folder inside the bucket, without a leading or trailing slash; empty for the bucket root.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."is_path_style" IS 'True addresses the bucket in the path (`endpoint/bucket/key`); false uses the bucket as a host name prefix.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."is_server_side_encrypted" IS 'True asks the storage to encrypt each object at rest with its own key (`AES256`).';--> statement-breakpoint
COMMENT ON COLUMN "destination"."access_key_id" IS 'Access key id for the bucket; an identifier, returned by the API.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."secret_key_sealed" IS 'Secret access key sealed with the instance data key (`tpsecret` envelope); never returned by any API.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."last_tested_at" IS 'When the connection test last ran against this target; null before the first test.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."is_last_test_ok" IS 'True when the last connection test passed, false when it failed; null before the first test.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."last_test_error" IS 'A plain reason the last connection test failed; null when it passed or was never run.';--> statement-breakpoint
COMMENT ON COLUMN "destination"."created_by" IS 'User who created the target, set null if that user is deleted.';--> statement-breakpoint
COMMENT ON TABLE "selection" IS 'Which backup target applies where: a row with no `managed_id` is the organization''s default, a row with one is that cluster''s own choice.';--> statement-breakpoint
COMMENT ON COLUMN "selection"."managed_id" IS 'The cluster this row overrides the default for; null for the organization default.';--> statement-breakpoint
COMMENT ON COLUMN "selection"."target_id" IS 'Target to copy to; null on a cluster row means no copy for that cluster even when a default exists.';
