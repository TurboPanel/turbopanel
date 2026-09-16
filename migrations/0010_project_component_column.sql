DROP INDEX "uniq_project_workspace_system_component";--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "component" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_workspace_system_component" ON "project" USING btree ("workspace_id","component") WHERE component IS NOT NULL;