-- breaking-ok: nothing is live before the fold, so tightening login settings in one step is safe
ALTER TABLE "login" DROP CONSTRAINT "login_role_check";--> statement-breakpoint
ALTER TABLE "login" DROP CONSTRAINT "login_grant_mode_check";--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "recipe" text;--> statement-breakpoint
ALTER TABLE "login" ADD COLUMN "is_all_databases" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "login" SET "grant_mode" = 'recipe' WHERE "grant_mode" = 'preset';--> statement-breakpoint
UPDATE "login" SET "recipe" = CASE
  WHEN "role" IN ('root', 'replication') THEN 'admin'
  WHEN 'admin' = ANY("privileges") THEN 'admin'
  WHEN 'owner' = ANY("privileges") THEN 'migrations'
  WHEN "access" = 'read-only' OR "privileges" = ARRAY['read-only']::text[] THEN 'read-only'
  ELSE 'app'
END WHERE "grant_mode" = 'recipe';--> statement-breakpoint
UPDATE "login" SET "allowed_sources" = ARRAY['address:0.0.0.0/0', 'address:::/0']::text[] WHERE "allowed_sources" IS NULL OR cardinality("allowed_sources") = 0;--> statement-breakpoint
ALTER TABLE "login" ALTER COLUMN "grant_mode" SET DEFAULT 'recipe';--> statement-breakpoint
ALTER TABLE "login" ALTER COLUMN "allowed_sources" SET DEFAULT '{internal}'::text[];--> statement-breakpoint
ALTER TABLE "login" ALTER COLUMN "allowed_sources" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_backup" ON "login" USING btree ("managed_id") WHERE "login"."role" = 'backup';--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_recipe_check" CHECK (recipe IS NULL OR recipe IN ('app', 'migrations', 'read-only', 'analyst', 'admin', 'backup'));--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_recipe_required_check" CHECK (grant_mode <> 'recipe' OR recipe IS NOT NULL);--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_allowed_sources_check" CHECK (cardinality(allowed_sources) BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_backup_sources_check" CHECK (role <> 'backup' OR cardinality(allowed_sources) >= 1);--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_role_check" CHECK (role IN ('root', 'replication', 'user', 'backup'));--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_grant_mode_check" CHECK (grant_mode IN ('recipe', 'self'));--> statement-breakpoint
COMMENT ON COLUMN "login"."role" IS '`root` is the cluster admin, `replication` the member-to-member login, `user` an operator login, `backup` the one login that takes backups.';--> statement-breakpoint
COMMENT ON COLUMN "login"."grant_mode" IS 'Who sets the permissions on reconcile: `recipe` (the panel, from the named `recipe`) or `self` (the owner by hand, never reset).';--> statement-breakpoint
COMMENT ON COLUMN "login"."recipe" IS 'The permission set the panel applies when `grant_mode` is `recipe`: `app`, `migrations`, `read-only`, `analyst`, `admin` or `backup`; NULL for `self`.';--> statement-breakpoint
COMMENT ON COLUMN "login"."is_all_databases" IS 'True for a reader of every database on the cluster, current and future; false means only the databases in `scope`.';--> statement-breakpoint
COMMENT ON COLUMN "login"."allowed_sources" IS 'Where the login may connect from (`internal`, `server:` and id, `address:` and an IP or range); never empty; anywhere is `address:0.0.0.0/0` and `address:::/0`.';--> statement-breakpoint
COMMENT ON COLUMN "login"."metadata" IS 'Internal bookkeeping jsonb; the grant ledger (grants the panel applied) will live here. Nothing writes it yet.';
