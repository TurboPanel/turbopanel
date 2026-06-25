-- Rename grant.allowed → grant.allow and license.hashed_token → license.token
ALTER TABLE "grant" RENAME COLUMN "allowed" TO "allow";--> statement-breakpoint
ALTER TABLE "license" RENAME COLUMN "hashed_token" TO "token";--> statement-breakpoint

-- Project: workspace parent (was under environment)
ALTER TABLE "project" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "project" p
SET "workspace_id" = e."workspace_id"
FROM "environment" e
WHERE e."id" = p."environment_id";--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint

-- Environment: project parent (was above project)
ALTER TABLE "environment" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "environment" e
SET "project_id" = (
  SELECT p."id" FROM "project" p WHERE p."environment_id" = e."id" LIMIT 1
);--> statement-breakpoint
INSERT INTO "project" ("id", "created_at", "updated_at", "display_name", "workspace_id")
SELECT uuidv7(), NOW(), NOW(), e."display_name", e."workspace_id"
FROM "environment" e
WHERE e."project_id" IS NULL;--> statement-breakpoint
UPDATE "environment" e
SET "project_id" = p."id"
FROM "project" p
WHERE e."project_id" IS NULL
  AND p."workspace_id" = e."workspace_id"
  AND p."display_name" IS NOT DISTINCT FROM e."display_name"
  AND p."created_at" >= NOW() - INTERVAL '1 second';--> statement-breakpoint
ALTER TABLE "environment" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint

-- Service: environment parent (was under project)
ALTER TABLE "service" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
UPDATE "service" s
SET "environment_id" = p."environment_id"
FROM "project" p
WHERE p."id" = s."project_id";--> statement-breakpoint
ALTER TABLE "service" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint

-- Hosting: optional service link; standalone keeps direct org scope
ALTER TABLE "hosting" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "hosting" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "hosting" h
SET "organization_id" = p."organization_id"
FROM "project" p
WHERE p."id" = h."project_id"
  AND h."organization_id" IS DISTINCT FROM p."organization_id";--> statement-breakpoint

-- Drop old composite FKs and redundant columns
ALTER TABLE "environment" DROP CONSTRAINT IF EXISTS "environment_workspace_org_fk";--> statement-breakpoint
ALTER TABLE "environment" DROP CONSTRAINT IF EXISTS "environment_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT IF EXISTS "project_environment_org_fk";--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT IF EXISTS "project_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "service" DROP CONSTRAINT IF EXISTS "service_project_org_fk";--> statement-breakpoint
ALTER TABLE "service" DROP CONSTRAINT IF EXISTS "service_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "hosting" DROP CONSTRAINT IF EXISTS "hosting_project_org_fk";--> statement-breakpoint

DROP INDEX IF EXISTS "idx_environment_workspace_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_environment_organization_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_environment_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_project_organization_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_service_project_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_service_organization_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_hosting_project_id";--> statement-breakpoint

ALTER TABLE "environment" DROP CONSTRAINT IF EXISTS "environment_id_org_unique";--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT IF EXISTS "project_id_org_unique";--> statement-breakpoint
ALTER TABLE "service" DROP CONSTRAINT IF EXISTS "service_id_org_unique";--> statement-breakpoint
ALTER TABLE "hosting" DROP CONSTRAINT IF EXISTS "hosting_id_org_unique";--> statement-breakpoint

ALTER TABLE "environment" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "environment" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "environment_id";--> statement-breakpoint
ALTER TABLE "service" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "service" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "hosting" DROP COLUMN "project_id";--> statement-breakpoint

-- New FKs and indexes
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "idx_project_workspace_id" ON "project" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_project_id" ON "environment" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_service_environment_id" ON "service" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_service_id" ON "hosting" USING btree ("service_id" uuid_ops);--> statement-breakpoint

ALTER TABLE "hosting" ADD CONSTRAINT "hosting_scope_check" CHECK ((((service_id IS NOT NULL) AND (organization_id IS NULL)) OR ((service_id IS NULL) AND (organization_id IS NOT NULL))));--> statement-breakpoint
