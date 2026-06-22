-- Drop FK that references realm before renaming
ALTER TABLE "environment" DROP CONSTRAINT "environment_realm_org_fk";

-- Rename the table
ALTER TABLE "realm" RENAME TO "workspace";

-- Rename the column on environment
ALTER TABLE "environment" RENAME COLUMN "realm_id" TO "workspace_id";

-- Rename constraints on workspace (formerly realm)
ALTER TABLE "workspace" RENAME CONSTRAINT "realm_pkey" TO "workspace_pkey";
ALTER TABLE "workspace" RENAME CONSTRAINT "realm_id_org_unique" TO "workspace_id_org_unique";
ALTER TABLE "workspace" RENAME CONSTRAINT "realm_organization_id_organization_id_fk" TO "workspace_organization_id_organization_id_fk";
ALTER TABLE "workspace" RENAME CONSTRAINT "realm_display_name_format_check" TO "workspace_display_name_format_check";

-- Rename index on workspace
ALTER INDEX "idx_realm_organization_id" RENAME TO "idx_workspace_organization_id";

-- Rename index on environment (realm_id → workspace_id)
ALTER INDEX "idx_environment_realm_id" RENAME TO "idx_environment_workspace_id";

-- Re-add the FK from environment to workspace with the new names
ALTER TABLE "environment" ADD CONSTRAINT "environment_workspace_org_fk"
  FOREIGN KEY ("workspace_id", "organization_id")
  REFERENCES "public"."workspace"("id", "organization_id")
  ON DELETE cascade ON UPDATE no action;
