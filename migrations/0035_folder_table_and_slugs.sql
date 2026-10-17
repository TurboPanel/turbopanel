CREATE TABLE "folder" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"environment_id" uuid,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"service_id" uuid,
	"storage_id" uuid,
	"state" text NOT NULL,
	CONSTRAINT "folder_kind_check" CHECK (kind IN ('service', 'volume')),
	CONSTRAINT "folder_state_check" CHECK (state IN ('planned', 'present', 'removing', 'orphan', 'missing')),
	CONSTRAINT "folder_slug_check" CHECK (slug ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$' AND slug !~ '\.\.'),
	CONSTRAINT "folder_scope_check" CHECK (scope = 'common' OR (scope ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND scope NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging'))),
	CONSTRAINT "folder_common_scope_check" CHECK (scope <> 'common' OR environment_id IS NULL),
	CONSTRAINT "folder_asset_kind_check" CHECK ((kind = 'service' AND storage_id IS NULL) OR (kind = 'volume' AND service_id IS NULL)),
	CONSTRAINT "folder_asset_present_check" CHECK (state IN ('removing', 'orphan', 'missing') OR (kind = 'service' AND service_id IS NOT NULL) OR (kind = 'volume' AND storage_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "is_common" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storage" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "storage" ADD COLUMN "is_common" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_folder_location" ON "folder" USING btree ("server_id","principal_id","scope","kind","slug");--> statement-breakpoint
CREATE INDEX "idx_folder_principal_id" ON "folder" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_environment_id" ON "folder" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_service_id" ON "folder" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_storage_id" ON "folder" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_organization_slug" ON "project" USING btree ("organization_id","slug") WHERE slug IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_service_environment_slug" ON "service" USING btree ("environment_id","slug") WHERE slug IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_slug_check" CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{0,39}$');--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_slug_check" CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$' AND slug !~ '\.\.'));--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_slug_check" CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$' AND slug !~ '\.\.'));--> statement-breakpoint
COMMENT ON TABLE "folder" IS 'One service or volume folder on one server, the record of what exists under a site owner scope; it locks environment, asset, project and organization naming.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."scope" IS 'Scope folder name exactly as created on the host: the environment name, or `common` for assets shared by every environment.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."kind" IS '`service` or `volume`; decides which of `service_id` and `storage_id` can be set.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."slug" IS 'Folder name of the asset, copied from its slug when the folder was planned.';--> statement-breakpoint
COMMENT ON COLUMN "project"."slug" IS 'Short name taken from the project name, unique per organization and never part of a path; editable until any folder exists under the project, then locked.';--> statement-breakpoint
COMMENT ON COLUMN "service"."slug" IS 'Folder name under the site owner tree, unique per environment; set at creation, locked once a `folder` row exists, NULL until set.';--> statement-breakpoint
COMMENT ON COLUMN "service"."is_common" IS 'True when the folder is in the `common` scope shared by every environment; chosen at creation and never changed.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."slug" IS 'Folder name of a panel-owned volume under the site owner tree; set at creation, locked once a `folder` row exists, NULL until set.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."is_common" IS 'True when the volume folder is in the `common` scope shared by every environment; chosen at creation and never changed.';;--> statement-breakpoint
COMMENT ON COLUMN "folder"."state" IS '`planned` before the host has it, `present`, `removing` until the host confirms a delete, `orphan` found with no asset, `missing` gone from the host.';