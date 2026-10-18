-- breaking-ok: the old columns, lists and tables are converted in this migration, so an old Worker cannot read the new shape
-- Final shape before launch: command and audit columns and indexes, promoted settings columns, latest hardware and plan on the server row, dead columns and unused JSON pairs dropped.
CREATE TABLE "watch" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"repository_id" uuid NOT NULL,
	"environment_id" uuid,
	"project_id" uuid,
	CONSTRAINT "watch_target_check" CHECK ((environment_id IS NOT NULL AND project_id IS NULL) OR (environment_id IS NULL AND project_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "environment" DROP CONSTRAINT "environment_name_format_check";--> statement-breakpoint
ALTER TABLE "managed" DROP CONSTRAINT "managed_status_check";--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT "project_slug_check";--> statement-breakpoint
ALTER TABLE "replica" DROP CONSTRAINT "replica_status_check";--> statement-breakpoint
ALTER TABLE "service" DROP CONSTRAINT "service_name_format_check";--> statement-breakpoint
ALTER TABLE "audit" DROP CONSTRAINT "audit_actor_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "idx_audit_organization_created";--> statement-breakpoint
DROP INDEX "idx_audit_target";--> statement-breakpoint
DROP INDEX "idx_binding_service_id";--> statement-breakpoint
DROP INDEX "idx_command_server_id_created_at";--> statement-breakpoint
DROP INDEX "idx_command_status";--> statement-breakpoint
DROP INDEX "idx_command_deploy_environment_created";--> statement-breakpoint
DROP INDEX "idx_container_service_id";--> statement-breakpoint
DROP INDEX "idx_deployment_environment_id";--> statement-breakpoint
DROP INDEX "idx_fabric_organization_id";--> statement-breakpoint
DROP INDEX "idx_forge_provider";--> statement-breakpoint
DROP INDEX "idx_connection_organization_id";--> statement-breakpoint
DROP INDEX "idx_permission_entity";--> statement-breakpoint
DROP INDEX "idx_ip_organization_id";--> statement-breakpoint
DROP INDEX "idx_label_server_id";--> statement-breakpoint
DROP INDEX "idx_managed_environment_id";--> statement-breakpoint
DROP INDEX "idx_mount_service_id";--> statement-breakpoint
DROP INDEX "uniq_project_organization_slug";--> statement-breakpoint
DROP INDEX "idx_relay_fabric_id";--> statement-breakpoint
DROP INDEX "idx_replica_managed_id";--> statement-breakpoint
DROP INDEX "idx_repository_organization_id";--> statement-breakpoint
DROP INDEX "idx_repository_connection_id";--> statement-breakpoint
DROP INDEX "idx_server_machine_key";--> statement-breakpoint
DROP INDEX "idx_server_hostname";--> statement-breakpoint
DROP INDEX "idx_service_environment_id";--> statement-breakpoint
DROP INDEX "idx_ssh_principal_id";--> statement-breakpoint
DROP INDEX "idx_subnet_network_id";--> statement-breakpoint
DROP INDEX "idx_seat_subscription_id";--> statement-breakpoint
DROP INDEX "idx_tag_organization_id";--> statement-breakpoint
DROP INDEX "idx_task_service_id";--> statement-breakpoint
DROP INDEX "idx_teammate_team_id";--> statement-breakpoint
DROP INDEX "idx_tenancy_principal_id";--> statement-breakpoint
DROP INDEX "idx_totp_user_id";--> statement-breakpoint
DROP INDEX "idx_delivery_stripe_pending";--> statement-breakpoint
DROP INDEX "idx_command_managed_destroy_gate_id";--> statement-breakpoint
ALTER TABLE "environment" ALTER COLUMN "name" SET DEFAULT replace(uuidv7()::text, '-', '');--> statement-breakpoint
ALTER TABLE "managed" ALTER COLUMN "status" SET DEFAULT 'provisioning';--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "slug" SET DEFAULT uuidv7()::text;--> statement-breakpoint
ALTER TABLE "replica" ALTER COLUMN "status" SET DEFAULT 'provisioning';--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "database_id" uuid;--> statement-breakpoint
ALTER TABLE "bulwark" ADD COLUMN "last_kind" text;--> statement-breakpoint
ALTER TABLE "command" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "command" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "command" ADD COLUMN "managed_id" uuid;--> statement-breakpoint
ALTER TABLE "hosting" ADD COLUMN "pending_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "default_server_id" uuid;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "machine_class_source" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "hardware" jsonb;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "capability" jsonb;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "offline_reason" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "daemon_commit" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "daemon_built_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "daemon_update_status" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "external_access_pending_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "stage" ADD COLUMN "phase" text DEFAULT 'fleet' NOT NULL;--> statement-breakpoint
-- F1 (run BEFORE the ADD CONSTRAINT "uniq_server_machine_key" statement): one registration per machine key. The oldest server keeps it.
UPDATE "server" SET "machine_key" = NULL WHERE "id" IN (SELECT "id" FROM (SELECT "id", row_number() OVER (PARTITION BY "machine_key" ORDER BY "created_at", "id") AS "rn" FROM "server" WHERE "machine_key" IS NOT NULL) x WHERE x."rn" > 1);--> statement-breakpoint
-- F1 (run AFTER the ADD COLUMN statements on "server", BEFORE DROP TABLE "generation" / "capability"): latest hardware and plan move onto the server row.
UPDATE "server" s SET "hardware" = jsonb_build_object(
  'generation', g."generation",
  'bootGeneration', g."boot_generation",
  'snapshot', g."snapshot",
  'appliedAt', to_jsonb(g."applied_at"),
  'updatedAt', to_jsonb(g."created_at"),
  'changes', '[]'::jsonb
)
FROM (SELECT DISTINCT ON ("server_id") "server_id", "generation", "boot_generation", "snapshot", "applied_at", "created_at" FROM "generation" ORDER BY "server_id", "created_at" DESC, "id" DESC) g
WHERE g."server_id" = s."id";--> statement-breakpoint
UPDATE "server" s SET "capability" = jsonb_build_object(
  'generation', c."generation",
  'planHash', c."plan_hash",
  'plan', c."plan",
  'appliedAt', to_jsonb(c."applied_at")
)
FROM (SELECT DISTINCT ON ("server_id") "server_id", "generation", "plan_hash", "plan", "applied_at" FROM "capability" ORDER BY "server_id", "generation" DESC) c
WHERE c."server_id" = s."id";--> statement-breakpoint
-- An existing machine class was set by an operator or proven by ingest; either way ingest never overwrites it.
UPDATE "server" SET "machine_class_source" = 'operator' WHERE "machine_class" IS NOT NULL;--> statement-breakpoint
-- Filtered projection keys become columns.
UPDATE "server" SET
  "offline_reason" = CASE WHEN "daemon" -> 'projection' ->> 'offlineReason' IN ('disconnect', 'sweep_stale') THEN "daemon" -> 'projection' ->> 'offlineReason' END,
  "daemon_commit" = NULLIF("daemon" -> 'projection' -> 'daemonBuild' ->> 'commit', ''),
  "daemon_built_at" = CASE WHEN "daemon" -> 'projection' -> 'daemonBuild' ->> 'builtAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' THEN ("daemon" -> 'projection' -> 'daemonBuild' ->> 'builtAt')::timestamptz END,
  "daemon_update_status" = CASE WHEN "daemon" -> 'projection' -> 'update' ->> 'status' IN ('idle', 'updating', 'done', 'failed', 'expired') THEN "daemon" -> 'projection' -> 'update' ->> 'status' END
WHERE "daemon" IS NOT NULL;--> statement-breakpoint
UPDATE "server" SET "external_access_pending_at" = ("options" -> 'managedExternalAccess' ->> 'pendingSince')::timestamptz
WHERE "options" -> 'managedExternalAccess' ->> 'pendingSince' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}';--> statement-breakpoint
UPDATE "server" SET "options" = jsonb_set("options", '{managedExternalAccess}', ("options" -> 'managedExternalAccess') - 'pendingSince')
WHERE jsonb_typeof("options" -> 'managedExternalAccess') = 'object' AND "options" -> 'managedExternalAccess' ? 'pendingSince';--> statement-breakpoint
-- command: the organization, environment and cluster a command is about were server rows and context keys.
UPDATE "command" c SET "organization_id" = s."organization_id" FROM "server" s WHERE s."id" = c."server_id" AND c."organization_id" IS NULL;--> statement-breakpoint
UPDATE "command" c SET "environment_id" = e."id" FROM "environment" e WHERE c."environment_id" IS NULL AND c."context" ->> 'environmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND e."id" = (c."context" ->> 'environmentId')::uuid;--> statement-breakpoint
UPDATE "command" c SET "managed_id" = m."id" FROM "managed" m WHERE c."managed_id" IS NULL AND c."context" ->> 'managedId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND m."id" = (c."context" ->> 'managedId')::uuid;--> statement-breakpoint
-- Ids that point at nothing cannot get the new foreign keys.
UPDATE "deployment" SET "last_command_id" = NULL WHERE "last_command_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "command" c WHERE c."id" = "deployment"."last_command_id");--> statement-breakpoint
UPDATE "recovery" SET "target_member_id" = NULL WHERE "target_member_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "replica" r WHERE r."id" = "recovery"."target_member_id");--> statement-breakpoint
-- hosting: a waiting Let's Encrypt request moves from metadata.letsEncryptPending to pending_at (+ metadata.letsEncryptDns).
UPDATE "hosting" SET
  "pending_at" = CASE WHEN ("metadata" -> 'letsEncryptPending' ->> 'requestedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN ("metadata" -> 'letsEncryptPending' ->> 'requestedAt')::timestamptz END,
  "metadata" = ("metadata" - 'letsEncryptPending') || CASE WHEN jsonb_typeof("metadata" -> 'letsEncryptPending' -> 'dns') = 'object' THEN jsonb_build_object('letsEncryptDns', "metadata" -> 'letsEncryptPending' -> 'dns') ELSE '{}'::jsonb END
WHERE "metadata" ? 'letsEncryptPending';--> statement-breakpoint
-- project: the default placement server leaves options for default_server_id (only when that server still exists).
UPDATE "project" p SET "default_server_id" = s."id"
FROM "server" s
WHERE p."options" ->> 'defaultServerId' = s."id"::text;--> statement-breakpoint
UPDATE "project" SET "options" = "options" - 'defaultServerId' WHERE "options" ? 'defaultServerId';--> statement-breakpoint
-- stage: the phase leaves detail for its own column.
UPDATE "stage" SET
  "phase" = CASE WHEN "detail" ->> 'phase' IN ('colocated_daemon', 'control_plane', 'fleet') THEN "detail" ->> 'phase' ELSE 'fleet' END,
  "detail" = "detail" - 'phase'
WHERE "detail" IS NOT NULL AND "detail" ? 'phase';--> statement-breakpoint
-- bulwark: the kind of the stored record gets a column.
UPDATE "bulwark" SET "last_kind" = "last_result" ->> 'kind'
WHERE "last_result" ->> 'kind' IN ('preview', 'apply', 'remove');--> statement-breakpoint
-- watch: which environments and projects name which repository in their compose.
INSERT INTO "watch" ("repository_id", "environment_id")
SELECT r."id", e."id"
FROM "environment" e
JOIN "project" p ON p."id" = e."project_id"
JOIN "repository" r ON r."organization_id" = p."organization_id"
WHERE jsonb_path_exists(e."options", '$."compose"."data"."services".**."x-turbopanel".**."source".**."sourceId".** ? (@ == $sid)'::jsonpath, jsonb_build_object('sid', r."id"::text));--> statement-breakpoint
INSERT INTO "watch" ("repository_id", "project_id")
SELECT r."id", p."id"
FROM "project" p
JOIN "repository" r ON r."organization_id" = p."organization_id"
WHERE jsonb_path_exists(p."options", '$."compose"."data"."services".**."x-turbopanel".**."source".**."sourceId".** ? (@ == $sid)'::jsonpath, jsonb_build_object('sid', r."id"::text));--> statement-breakpoint
-- project: every project gets a slug (the rule: lowercase letters, digits and hyphens, up to 40, unique per organization).
UPDATE "project" p SET "slug" = x."slug"
FROM (
  SELECT q."id",
    CASE WHEN q."base" = '' THEN 'project-' || right(replace(q."id"::text, '-', ''), 8)
         ELSE q."base" || '-' || right(replace(q."id"::text, '-', ''), 8) END AS "slug"
  FROM (
    SELECT "id", trim(both '-' from left(regexp_replace(lower(coalesce("name", '')), '[^a-z0-9]+', '-', 'g'), 30)) AS "base"
    FROM "project" WHERE "slug" IS NULL
  ) q
) x
WHERE p."id" = x."id";--> statement-breakpoint
-- environment: every environment gets a valid, unique name (the folder rule: lowercase letters, digits, _ and -, up to 32, not reserved).
UPDATE "environment" e SET "name" = x."name"
FROM (
  SELECT q."id",
    CASE WHEN q."base" = '' THEN 'env-' || right(replace(q."id"::text, '-', ''), 8)
         ELSE q."base" || '-' || right(replace(q."id"::text, '-', ''), 8) END AS "name"
  FROM (
    SELECT "id",
      trim(both '-' from left(regexp_replace(lower(coalesce("name", '')), '[^a-z0-9]+', '-', 'g'), 23)) AS "base"
    FROM "environment"
    WHERE "name" IS NULL
      OR "name" !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
      OR "name" IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging')
  ) q
) x
WHERE e."id" = x."id";--> statement-breakpoint
-- environment: two environments of one project may not share a name; later ones take a suffix.
UPDATE "environment" e SET "name" = left(e."name", 23) || '-' || right(replace(e."id"::text, '-', ''), 8)
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "project_id", "name" ORDER BY "created_at", "id") AS "n" FROM "environment"
) d
WHERE d."id" = e."id" AND d."n" > 1;--> statement-breakpoint
-- folder: the scope folder follows the renamed environment.
UPDATE "folder" f SET "scope" = e."name"
FROM "environment" e
WHERE e."id" = f."environment_id" AND f."scope" <> 'common' AND f."scope" <> e."name";--> statement-breakpoint
-- managed and replica: a missing status reads as the first state.
UPDATE "managed" SET "status" = 'provisioning' WHERE "status" IS NULL;--> statement-breakpoint
UPDATE "replica" SET "status" = 'provisioning' WHERE "status" IS NULL;--> statement-breakpoint
-- backup.database_id from the database name the dump was of
UPDATE "backup" b SET "database_id" = d."id" FROM "database" d WHERE b."database" IS NOT NULL AND d."managed_id" = b."managed_id" AND d."name" = b."database";--> statement-breakpoint
-- artifact paths become relative to the backup root of the host
UPDATE "backup" SET "path" = substr("path", position('/managed/' || "managed_id"::text || '/' in "path") + 1) WHERE "path" LIKE '/%' AND position('/managed/' || "managed_id"::text || '/' in "path") > 0;--> statement-breakpoint
UPDATE "backup" SET "path" = 'managed/' || substr("path", position('/' || "managed_id"::text || '/' in "path") + 1) WHERE "path" LIKE '/%' AND position('/' || "managed_id"::text || '/' in "path") > 0;--> statement-breakpoint
UPDATE "archive" SET "path" = substr("path", position('/volumes/' || "copy_id"::text || '/' in "path") + 1) WHERE "path" LIKE '/%' AND position('/volumes/' || "copy_id"::text || '/' in "path") > 0;--> statement-breakpoint
UPDATE "archive" SET "path" = 'volumes/' || substr("path", position('/copies/' || "copy_id"::text || '/' in "path") + 8) WHERE "path" LIKE '/%' AND position('/copies/' || "copy_id"::text || '/' in "path") > 0;--> statement-breakpoint
ALTER TABLE "capability" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "capability" CASCADE;--> statement-breakpoint
DROP TABLE "generation" CASCADE;--> statement-breakpoint
ALTER TABLE "environment" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "managed" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "replica" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "watch" ADD CONSTRAINT "watch_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch" ADD CONSTRAINT "watch_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch" ADD CONSTRAINT "watch_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_watch_repository_environment" ON "watch" USING btree ("repository_id","environment_id") WHERE "watch"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_watch_repository_project" ON "watch" USING btree ("repository_id","project_id") WHERE "watch"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_watch_environment_id" ON "watch" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_watch_project_id" ON "watch" USING btree ("project_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_last_command_id_command_id_fk" FOREIGN KEY ("last_command_id") REFERENCES "public"."command"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_server_id_server_id_fk" FOREIGN KEY ("default_server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery" ADD CONSTRAINT "recovery_target_member_id_replica_id_fk" FOREIGN KEY ("target_member_id") REFERENCES "public"."replica"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_allowance_tier_id" ON "allowance" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "idx_audit_organization_recent" ON "audit" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_backup_database_id" ON "backup" USING btree ("database_id");--> statement-breakpoint
CREATE INDEX "idx_command_server_recent" ON "command" USING btree ("server_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_command_open" ON "command" USING btree ("status","updated_at") WHERE "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running');--> statement-breakpoint
CREATE INDEX "idx_command_managed" ON "command" USING btree ("managed_id") WHERE "command"."managed_id" IS NOT NULL AND "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running');--> statement-breakpoint
CREATE INDEX "idx_command_feed" ON "command" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" IN ('environment.deploy', 'environment.lifecycle', 'environment.stop') AND "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running', 'failed', 'timed_out');--> statement-breakpoint
CREATE INDEX "idx_command_deploy" ON "command" USING btree ("environment_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" = 'environment.deploy';--> statement-breakpoint
CREATE INDEX "idx_deployment_last_command" ON "deployment" USING btree ("last_command_id") WHERE "deployment"."last_command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_edict_created_by" ON "edict" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_hosting_pending" ON "hosting" USING btree ("updated_at") WHERE "hosting"."pending_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_leaf_replica_id" ON "leaf" USING btree ("replica_id");--> statement-breakpoint
CREATE INDEX "idx_lease_organization_id" ON "lease" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_license_server_id" ON "license" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_notification_unread" ON "notification" USING btree ("user_id") WHERE "notification"."read_at" IS NULL AND "notification"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notification_organization_id" ON "notification" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_channel_created_by_user_id" ON "channel" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_attempt_organization_id" ON "attempt" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_project_default_server_id" ON "project" USING btree ("default_server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_repository_connection_external" ON "repository" USING btree ("connection_id","repository_external_id");--> statement-breakpoint
CREATE INDEX "idx_retention_created_by" ON "retention" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_server_offline" ON "server" USING btree ("status_changed_at" DESC NULLS LAST) WHERE "server"."is_connected" = false;--> statement-breakpoint
CREATE INDEX "idx_server_updating" ON "server" USING btree ("id") WHERE "server"."daemon_update_status" = 'updating';--> statement-breakpoint
CREATE INDEX "idx_stage_upgrade_phase" ON "stage" USING btree ("upgrade_id","phase","batch_index","status");--> statement-breakpoint
CREATE INDEX "idx_upgrade_started_by" ON "upgrade" USING btree ("started_by");--> statement-breakpoint
CREATE INDEX "idx_delivery_pending" ON "delivery" USING btree ("updated_at") WHERE "delivery"."provider" = 'stripe' AND "delivery"."projected_at" IS NULL AND "delivery"."object_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_command_managed_destroy_gate_id" ON "command" USING btree ("managed_destroy_gate_id" text_ops) WHERE "command"."managed_destroy_gate_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "access_token";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "refresh_token";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "id_token";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "access_token_expires_at";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "refresh_token_expires_at";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "binding" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "binding" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "changeover" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "address" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "command" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "forge" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "forge" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "connection" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "recovery" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "replica" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "secret" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "slot" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "slot" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "storage" DROP COLUMN "generation";--> statement-breakpoint
ALTER TABLE "copy" DROP COLUMN "generation";--> statement-breakpoint
ALTER TABLE "subnet" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "tag" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "tag" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "team" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "team" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "uniq_environment_project_name" UNIQUE("project_id","name");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "uniq_project_organization_slug" UNIQUE("organization_id","slug");--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "uniq_server_machine_key" UNIQUE("machine_key");--> statement-breakpoint
ALTER TABLE "bulwark" ADD CONSTRAINT "bulwark_last_kind_check" CHECK (last_kind IS NULL OR last_kind IN ('preview', 'apply', 'remove'));--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_name_check" CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND name NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging'));--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_engine_check" CHECK (engine IN ('postgres', 'mysql', 'mariadb', 'redis', 'clickhouse'));--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_status_check" CHECK (status IN ('provisioning','applying','ready','stopped','failed'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_slug_check" CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$');--> statement-breakpoint
ALTER TABLE "replica" ADD CONSTRAINT "replica_status_check" CHECK (status IN ('provisioning','applying','ready','stopped','failed','needs_resync'));--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_machine_class_source_check" CHECK (machine_class_source IN ('detected', 'operator'));--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_offline_reason_check" CHECK (offline_reason IN ('disconnect', 'sweep_stale'));--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_daemon_update_status_check" CHECK (daemon_update_status IN ('idle', 'updating', 'done', 'failed', 'expired'));--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_phase_check" CHECK (phase IN ('colocated_daemon', 'control_plane', 'fleet'));
--> statement-breakpoint
COMMENT ON COLUMN "archive"."path" IS 'Artifact path relative to the backup root of the copy''s server (`volumes/` plus the copy id, then the file).';--> statement-breakpoint
COMMENT ON COLUMN "audit"."actor_user_id" IS 'User who acted, a plain id with no FK so it survives the account''s deletion; null only for an action the platform took on nobody''s behalf.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."database" IS 'Database name for a single-database backup, kept as history; null for an instance-scope backup.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."database_id" IS 'The `database` row the dump was of, set null if that database is dropped; null for an instance-scope backup.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."path" IS 'Artifact path relative to the backup root of the host that made it (`managed/` plus the cluster id, then the file).';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_kind" IS 'Which kind of record `last_result` holds: `preview`, `apply` or `remove`; the firewall sweep filters on it, and it is null before any record.';--> statement-breakpoint
COMMENT ON COLUMN "command"."organization_id" IS 'Organization of the server, copied at insert so the activity feed and org-wide lists filter without a join; set null if the organization row goes.';--> statement-breakpoint
COMMENT ON COLUMN "command"."environment_id" IS 'Environment a deploy, lifecycle or stop command was issued for (also kept in `context`); set null when the environment is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "command"."managed_id" IS 'Managed cluster the command acts on (also kept in `context`); set null when the cluster is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."last_command_id" IS 'Id of the `command` row for the most recent apply attempt on this pair, set null when that command is pruned; the join key into the command history.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."name" IS 'Scope folder name on every server, under `environment_name_check` (lowercase letters, digits, `_` and `-`, up to 32 chars, not reserved); unique per project.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."pending_at" IS 'When a waiting Let''s Encrypt request was made because DNS did not point here yet; NULL when none is waiting, and the sweep retries every row with a value.';--> statement-breakpoint
COMMENT ON COLUMN "network"."metadata" IS 'Free-form client jsonb that the networks API accepts; also read as a legacy fallback for `metadata.dockerNetworkName` when `options` lacks it.';--> statement-breakpoint
COMMENT ON COLUMN "project"."default_server_id" IS 'Default placement server: an environment with no `server_id` of its own inherits it; set null when the server is deleted (API field `options.defaultServerId`).';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."source_primary_member_id" IS '`replica.id` of the primary being replaced, stored without an FK on purpose so the journal outlives the member.';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."target_member_id" IS '`replica.id` of the member being promoted, set null if that member is removed; null when an automatic failover was `blocked` with no eligible candidate.';--> statement-breakpoint
COMMENT ON COLUMN "server"."machine_class_source" IS 'Who set `machine_class`: `detected` (ingest wrote it back from the topology) or `operator` (a PATCH pinned or cleared it); NULL while the class is NULL.';--> statement-breakpoint
COMMENT ON COLUMN "server"."hardware" IS 'Latest hardware layout the daemon reported (generation, boot generation, snapshot, times); overwritten in place, no history, never read by list screens.';--> statement-breakpoint
COMMENT ON COLUMN "server"."capability" IS 'Latest resolved metrics capability plan (generation, hash, plan, applied time); overwritten in place and recomputable from the box size and hardware.';--> statement-breakpoint
COMMENT ON COLUMN "server"."offline_reason" IS 'Why the host is offline: `disconnect` (socket closed) or `sweep_stale` (no heartbeat, likely power loss); NULL while online.';--> statement-breakpoint
COMMENT ON COLUMN "server"."daemon_commit" IS 'Commit of the daemon build running on the host, from its hello or heartbeat.';--> statement-breakpoint
COMMENT ON COLUMN "server"."daemon_built_at" IS 'Build time of the daemon build running on the host.';--> statement-breakpoint
COMMENT ON COLUMN "server"."daemon_update_status" IS 'Daemon self-update state: `idle`, `updating`, `done`, `failed` or `expired`; NULL until the host reports one.';--> statement-breakpoint
COMMENT ON COLUMN "server"."external_access_pending_at" IS 'When the host was last asked to change database external access and has not confirmed; a sweep re-sends it while set.';--> statement-breakpoint
COMMENT ON COLUMN "service"."metadata" IS 'Client jsonb for non-indexed facts plus the daemon-detected `app` fact; promoted identity keys are stripped on write and the compose name never lives here.';--> statement-breakpoint
COMMENT ON COLUMN "service"."name" IS 'User-facing label (formerly `display_name`), nullable and not unique; reconcile defaults it to the compose service key.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."phase" IS 'Which part of the run the step belongs to: `colocated_daemon` first, then `control_plane`, then `fleet`; checked against the run order.';--> statement-breakpoint
COMMENT ON TABLE "watch" IS 'Which environment or project follows which repository, derived from the compose document that names it; a project row reaches every environment of the project.';--> statement-breakpoint
COMMENT ON COLUMN "watch"."environment_id" IS 'Set when the environment own compose names the repository; exactly one of this and `project_id` is set.';--> statement-breakpoint
COMMENT ON COLUMN "watch"."project_id" IS 'Set when the project compose names the repository; exactly one of this and `environment_id` is set.';
