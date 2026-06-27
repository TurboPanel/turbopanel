ALTER TABLE "environment" DROP CONSTRAINT "environment_project_id_project_id_fk";
--> statement-breakpoint
ALTER TABLE "hosting" DROP CONSTRAINT "hosting_service_id_service_id_fk";
--> statement-breakpoint
ALTER TABLE "network" DROP CONSTRAINT "network_server_id_server_id_fk";
--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT "project_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "service" DROP CONSTRAINT "service_environment_id_environment_id_fk";
--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE restrict ON UPDATE no action;