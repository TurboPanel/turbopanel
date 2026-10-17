-- breaking-ok: the old columns and lists are converted in this migration, so an old Worker cannot read the new shape
-- Finishes the login split: principal is only a site owner's Linux user, binding points at a login and a database,
-- login settings are real columns, and databases and the logins that can use them are rows.
CREATE TABLE "database" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"managed_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_role_owned" boolean DEFAULT false NOT NULL,
	"owner_login_id" uuid,
	CONSTRAINT "database_name_check" CHECK (char_length(name) >= 1),
	CONSTRAINT "database_owner_role_check" CHECK (owner_login_id IS NULL OR is_role_owned)
);
--> statement-breakpoint
CREATE TABLE "scope" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"login_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	CONSTRAINT "uniq_scope_login_database" UNIQUE("login_id","database_id")
);
--> statement-breakpoint
ALTER TABLE "binding" DROP CONSTRAINT "binding_database_name_format_check";--> statement-breakpoint
ALTER TABLE "principal" DROP CONSTRAINT "principal_kind_check";--> statement-breakpoint
ALTER TABLE "principal" DROP CONSTRAINT "principal_provider_check";--> statement-breakpoint
ALTER TABLE "binding" DROP CONSTRAINT "binding_principal_id_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "principal" DROP CONSTRAINT "principal_managed_id_managed_id_fk";
--> statement-breakpoint
DROP INDEX "idx_binding_principal_id";--> statement-breakpoint
DROP INDEX "idx_login_managed_id";--> statement-breakpoint
DROP INDEX "idx_principal_managed_id";--> statement-breakpoint
DROP INDEX "uniq_principal_organization_username";--> statement-breakpoint
DROP INDEX "uniq_principal_organization_applied_username";--> statement-breakpoint
ALTER TABLE "binding" ADD COLUMN "database_id" uuid;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "username" varchar(255);--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "name_scheme" text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "grant_mode" text DEFAULT 'preset' NOT NULL;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "is_tool" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "allowed_sources" text[];--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "max_connections" integer;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "access" text DEFAULT 'read-write' NOT NULL;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "privileges" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Carry the data over (a database that is not wiped keeps working until the wipe).
-- The databases of each cluster were string lists in managed.options.
INSERT INTO "database" ("managed_id", "name", "is_role_owned")
SELECT DISTINCT ON (m."id", lower(d."name")) m."id", d."name",
  COALESCE(m."options" -> 'ownerRoleDatabases' ? d."name", false)
FROM "managed" m
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(m."options" -> 'databases') = 'array' THEN m."options" -> 'databases' ELSE '[]'::jsonb END
) AS d("name")
ORDER BY m."id", lower(d."name"), d."name";--> statement-breakpoint
-- The login rows the old binding rows pointed at by principal only.
UPDATE "binding" b SET "login_id" = l."id"
FROM "login" l
WHERE b."login_id" IS NULL AND l."principal_id" = b."principal_id";--> statement-breakpoint
-- Login settings were jsonb keys; the typed name came from the principal row.
UPDATE "login" l SET
  "username" = COALESCE((SELECT p."username" FROM "principal" p WHERE p."id" = l."principal_id"), l."applied_username"),
  "name_scheme" = CASE WHEN l."options" ->> 'nameScheme' IN ('plain', 'partial', 'random') THEN l."options" ->> 'nameScheme' ELSE 'plain' END,
  "grant_mode" = CASE WHEN l."metadata" ->> 'grantMode' IN ('preset', 'recipe', 'self') THEN l."metadata" ->> 'grantMode' ELSE 'preset' END,
  "is_tool" = COALESCE(l."metadata" ->> 'tool', 'false') = 'true',
  "access" = CASE WHEN l."metadata" ->> 'connectionRole' = 'read-only' THEN 'read-only' ELSE 'read-write' END,
  "max_connections" = CASE WHEN jsonb_typeof(l."metadata" -> 'maxConnections') = 'number' AND (l."metadata" ->> 'maxConnections')::numeric >= 1 THEN (l."metadata" ->> 'maxConnections')::numeric::integer END,
  "allowed_sources" = CASE WHEN jsonb_typeof(l."metadata" -> 'allowedSources') = 'array' AND jsonb_array_length(l."metadata" -> 'allowedSources') > 0
    THEN ARRAY(SELECT jsonb_array_elements_text(l."metadata" -> 'allowedSources')) END,
  "privileges" = CASE WHEN jsonb_typeof(l."metadata" -> 'privileges') = 'array'
    THEN ARRAY(SELECT jsonb_array_elements_text(l."metadata" -> 'privileges')) ELSE '{}'::text[] END;--> statement-breakpoint
-- Which databases each login may use.
INSERT INTO "scope" ("login_id", "database_id")
SELECT x."login_id", x."database_id" FROM (
  SELECT DISTINCT ON (l."id", d."id") l."id" AS "login_id", d."id" AS "database_id", n."ord"
  FROM "login" l
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(l."metadata" -> 'databases') = 'array' THEN l."metadata" -> 'databases' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS n("name", "ord")
  JOIN "database" d ON d."managed_id" = l."managed_id" AND lower(d."name") = lower(n."name")
  ORDER BY l."id", d."id", n."ord"
) x ORDER BY x."login_id", x."ord";--> statement-breakpoint
-- The login each database owner was recorded as (it must still exist).
UPDATE "database" d SET "owner_login_id" = (m."options" -> 'databaseOwners' -> d."name" ->> 'loginId')::uuid
FROM "managed" m
WHERE m."id" = d."managed_id" AND d."is_role_owned"
  AND EXISTS (SELECT 1 FROM "login" l WHERE l."id"::text = m."options" -> 'databaseOwners' -> d."name" ->> 'loginId');--> statement-breakpoint
-- The database each binding pointed at by name; a binding that cannot be resolved is dropped.
UPDATE "binding" b SET "database_id" = d."id"
FROM "login" l, "database" d
WHERE l."id" = b."login_id" AND d."managed_id" = l."managed_id" AND d."name" = b."database_name";--> statement-breakpoint
DELETE FROM "binding" WHERE "login_id" IS NULL OR "database_id" IS NULL;--> statement-breakpoint
-- Database logins are no longer principals; their old rows go (logins that named one lose the link).
UPDATE "login" SET "principal_id" = NULL WHERE "principal_id" IN (SELECT "id" FROM "principal" WHERE "kind" = 'database');--> statement-breakpoint
DELETE FROM "principal" WHERE "kind" = 'database';--> statement-breakpoint
-- The cluster record named its root login by principal.
UPDATE "managed" m SET "metadata" = (m."metadata" - 'rootPrincipalId') || jsonb_build_object('rootLoginId', l."id")
FROM "login" l
WHERE l."managed_id" = m."id" AND l."role" = 'root' AND m."metadata" ? 'rootPrincipalId';--> statement-breakpoint
ALTER TABLE "login" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "binding" ALTER COLUMN "database_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "binding" ALTER COLUMN "login_id" SET NOT NULL;--> statement-breakpoint
-- managed.options keeps only the settings.
UPDATE "managed" SET "options" = "options" - 'databases' - 'ownerRoleDatabases' - 'databaseOwners' WHERE "options" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "database" ADD CONSTRAINT "database_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database" ADD CONSTRAINT "database_owner_login_id_login_id_fk" FOREIGN KEY ("owner_login_id") REFERENCES "public"."login"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_login_id_login_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."login"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_database_managed_name" ON "database" USING btree ("managed_id",lower("name"));--> statement-breakpoint
CREATE INDEX "idx_database_owner_login_id" ON "database" USING btree ("owner_login_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_scope_database_id" ON "scope" USING btree ("database_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_binding_database_id" ON "binding" USING btree ("database_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_username" ON "principal" USING btree ("organization_id",lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_applied_username" ON "principal" USING btree ("organization_id",lower("applied_username"));--> statement-breakpoint
ALTER TABLE "binding" DROP COLUMN "principal_id";--> statement-breakpoint
ALTER TABLE "binding" DROP COLUMN "database_name";--> statement-breakpoint
ALTER TABLE "login" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "login" DROP COLUMN "options";--> statement-breakpoint
ALTER TABLE "principal" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "principal" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "principal" DROP COLUMN "managed_id";--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_name_scheme_check" CHECK (name_scheme IN ('plain', 'partial', 'random'));--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_grant_mode_check" CHECK (grant_mode IN ('preset', 'recipe', 'self'));--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_access_check" CHECK (access IN ('read-write', 'read-only'));--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_max_connections_check" CHECK (max_connections IS NULL OR max_connections >= 1);
--> statement-breakpoint
COMMENT ON TABLE "binding" IS 'Join edge attaching a database login to a consuming compose service; materializes system-owned `variable` rows for deploy credential injection.';--> statement-breakpoint
COMMENT ON COLUMN "binding"."login_id" IS 'The `login` row whose credentials are injected; cascade-deleted with it (login gone, binding gone).';--> statement-breakpoint
COMMENT ON COLUMN "binding"."database_id" IS 'The `database` the credentials point at; ON DELETE RESTRICT so a database in use cannot be dropped.';--> statement-breakpoint
COMMENT ON TABLE "login" IS 'One engine role on one managed cluster; not a principal, which is only a site owner Linux user; written by the managed users API.';--> statement-breakpoint
COMMENT ON COLUMN "login"."principal_id" IS 'Site owner Linux user the login shares its name with, cascade-deleted with it; NULL for a login made on its own and for the root and replication logins.';--> statement-breakpoint
COMMENT ON COLUMN "login"."username" IS 'Name the customer typed; equals `applied_username` for `plain` names and for the root and replication logins.';--> statement-breakpoint
COMMENT ON COLUMN "login"."applied_username" IS 'Engine role name created on the cluster; unique per cluster after trim and case-fold, and equal to the principal name when `principal_id` is set.';--> statement-breakpoint
COMMENT ON COLUMN "login"."name_scheme" IS 'How `applied_username` was derived from `username`: `plain` (same), `partial` (plus a random suffix) or `random` (no trace of it).';--> statement-breakpoint
COMMENT ON COLUMN "login"."grant_mode" IS 'Who sets the permissions on reconcile: `preset` (logins from before modes), `recipe` (the panel) or `self` (the owner by hand, never reset).';--> statement-breakpoint
COMMENT ON COLUMN "login"."is_tool" IS 'True for a database-tool login: the daemon sends all of its traffic to the primary and adds no read/write split rules (API field `tool`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."allowed_sources" IS 'Places the login may connect from (`internal`, `server:` plus an id, `address:` plus a value); NULL means anywhere (API field `allowedSources`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."max_connections" IS 'Per-login cap on open connections, at least 1; NULL means no cap (API field `maxConnections`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."access" IS 'Routing: `read-write` sends the login to the primary, `read-only` to read replicas or the primary when there are none (API field `connectionRole`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."privileges" IS 'What the login may do in each database it can use: `owner`, `read-write`, `read-only` or `admin`; empty for the root and replication logins.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."metadata" IS 'Residual cluster facts: `rootLoginId` and `rootUsername` set at create, plus `host`, `port` and `error` written by the command consumer from daemon results.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."options" IS 'Operator settings jsonb with the key `settings` (engine ManagedSettings), written by the managed routes; the databases are `database` rows.';--> statement-breakpoint
COMMENT ON TABLE "database" IS 'One database inside a managed cluster: its name, whether it has an owner role and the login chosen as its owner; written by the managed databases API.';--> statement-breakpoint
COMMENT ON COLUMN "database"."name" IS 'Name on the engine as typed (1-255 chars); unique per cluster after case-fold.';--> statement-breakpoint
COMMENT ON COLUMN "database"."is_role_owned" IS 'Postgres only: true when the database is owned by an owner role (`tp_NAME_owner`, `_rw`, `_ro`).';--> statement-breakpoint
COMMENT ON COLUMN "database"."owner_login_id" IS 'Postgres only: the login the customer chose as owner; NULL means the default no-login owner role. Cleared when that login is deleted.';--> statement-breakpoint
COMMENT ON TABLE "principal" IS 'A site owner Linux user: the host account that runs sites and owns their tree; written by the principals API and the compose deploy.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."metadata" IS 'Holds `home` (under `/srv/users`), an optional `uid`/`gid` mirror and `composeAlias`.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."organization_id" IS 'Home organization set on every insert, not derived.';--> statement-breakpoint
COMMENT ON TABLE "scope" IS 'Which databases a login may use: one row per login and database; what it may do in them is `login.privileges`.';
