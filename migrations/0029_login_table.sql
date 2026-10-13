CREATE TABLE "login" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"managed_id" uuid NOT NULL,
	"principal_id" uuid,
	"role" text NOT NULL,
	"applied_username" varchar(255) NOT NULL,
	"password" text,
	CONSTRAINT "login_role_check" CHECK (role IN ('root', 'replication', 'user')),
	CONSTRAINT "login_applied_username_format_check" CHECK ((char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text))
);
--> statement-breakpoint
ALTER TABLE "binding" ADD COLUMN "login_id" uuid;--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_login_managed_id" ON "login" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_login_principal_id" ON "login" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_principal" ON "login" USING btree ("managed_id","principal_id") WHERE "login"."principal_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_login_id_login_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."login"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_binding_login_id" ON "binding" USING btree ("login_id" uuid_ops);--> statement-breakpoint
-- backfill: one login row per legacy database principal. The principal rows
-- stay (expand step); a user login points at its principal, the cluster's own
-- root and replication logins have no principal and remember the old row in
-- metadata.legacyPrincipalId so both rows can be kept in step until the
-- contract migration retires the old ones.
INSERT INTO "login" ("created_at", "updated_at", "metadata", "options", "managed_id", "principal_id", "role", "applied_username", "password")
SELECT
	p."created_at",
	p."updated_at",
	CASE
		WHEN COALESCE(p."metadata", '{}'::jsonb) ->> 'managedRoot' = 'true'
			OR COALESCE(p."metadata", '{}'::jsonb) ->> 'managedReplication' = 'true'
		THEN COALESCE(p."metadata", '{}'::jsonb) || jsonb_build_object('legacyPrincipalId', p."id")
		ELSE p."metadata"
	END,
	p."options",
	p."managed_id",
	CASE
		WHEN COALESCE(p."metadata", '{}'::jsonb) ->> 'managedRoot' = 'true'
			OR COALESCE(p."metadata", '{}'::jsonb) ->> 'managedReplication' = 'true'
		THEN NULL
		ELSE p."id"
	END,
	CASE
		WHEN COALESCE(p."metadata", '{}'::jsonb) ->> 'managedRoot' = 'true' THEN 'root'
		WHEN COALESCE(p."metadata", '{}'::jsonb) ->> 'managedReplication' = 'true' THEN 'replication'
		ELSE 'user'
	END,
	p."applied_username",
	p."password"
FROM "principal" p
WHERE p."kind" = 'database' AND p."managed_id" IS NOT NULL
ORDER BY p."created_at", p."id";--> statement-breakpoint
UPDATE "binding" b
SET "login_id" = l."id"
FROM "login" l
WHERE l."principal_id" = b."principal_id" AND b."login_id" IS NULL;--> statement-breakpoint
-- Report duplicates instead of renaming anything: the unique index below
-- refuses the upgrade with the offending names when two legacy rows on one
-- cluster share a login name (case-insensitively).
DO $$
DECLARE
	dupes text;
BEGIN
	SELECT string_agg(format('cluster %s login %s (%s rows)', d.managed_id, d.name, d.n), ', ')
	INTO dupes
	FROM (
		SELECT "managed_id", lower(btrim("applied_username")) AS name, count(*) AS n
		FROM "login"
		GROUP BY 1, 2
		HAVING count(*) > 1
	) d;
	IF dupes IS NOT NULL THEN
		RAISE EXCEPTION 'login names are not unique per cluster; fix these rows before upgrading: %', dupes;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_applied_username" ON "login" USING btree ("managed_id",lower(btrim(("applied_username")::text)));
--> statement-breakpoint
COMMENT ON COLUMN "binding"."login_id" IS 'The `login` row whose credentials are injected; set beside `principal_id` on every insert and backfilled from it, nullable until the contract migration.';--> statement-breakpoint
COMMENT ON TABLE "login" IS 'One engine role on one managed cluster, the database form of a principal; written by the managed users API in step with the legacy `principal` rows.';--> statement-breakpoint
COMMENT ON COLUMN "login"."metadata" IS 'Jsonb: `engine`, `databases`, `privileges`, optional `connectionRole`; cluster logins add `managedRoot` or `managedReplication` and `legacyPrincipalId`.';--> statement-breakpoint
COMMENT ON COLUMN "login"."options" IS 'Jsonb: `nameScheme` the applied name was derived with (`plain`, `partial`, `random`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."principal_id" IS 'Identity the login belongs to, cascade-deleted with it; NULL only for the cluster root and replication logins, which are outside the organization name pool.';--> statement-breakpoint
COMMENT ON COLUMN "login"."role" IS '`root` for the cluster admin login, `replication` for the member-to-member login, `user` for an operator-created login.';--> statement-breakpoint
COMMENT ON COLUMN "login"."applied_username" IS 'Engine role name created on the cluster, copied from the principal for a `user` login; unique per cluster after trim and case-fold.';--> statement-breakpoint
COMMENT ON COLUMN "login"."password" IS 'Write-only credential sealed as a `tpsecret` envelope, never returned on GET and resealed to `tpdaemon` for delivery.';
