ALTER TABLE "variable" DROP CONSTRAINT "variable_environment_id_key_unique";--> statement-breakpoint
ALTER TABLE "variable" ALTER COLUMN "environment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "description" varchar(255);--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_variable_organization_id" ON "variable" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_workspace_id" ON "variable" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_project_id" ON "variable" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_service_id" ON "variable" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_server_id" ON "variable" USING btree ("server_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_exactly_one_parent_check" CHECK (((organization_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (server_id IS NOT NULL)::int) = 1);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_org" ON "variable" USING btree ("key", "organization_id") WHERE organization_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_workspace" ON "variable" USING btree ("key", "workspace_id") WHERE workspace_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_project" ON "variable" USING btree ("key", "project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_environment" ON "variable" USING btree ("key", "environment_id") WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_service" ON "variable" USING btree ("key", "service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_server" ON "variable" USING btree ("key", "server_id") WHERE server_id IS NOT NULL;