ALTER TABLE "variable" ADD COLUMN "is_literal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "for_build" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "variable" ADD COLUMN "for_runtime" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_principal_project_id" ON "principal" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE TABLE "storage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"kind" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"source_path" text,
	"destination_path" text,
	"principal_id" uuid,
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "storage_kind_check" CHECK (kind IN ('docker_volume', 'bind_mount', 'file', 'directory')),
	CONSTRAINT "storage_exactly_one_parent_check" CHECK (((project_id IS NOT NULL)::int + (environment_id IS NOT NULL)::int + (service_id IS NOT NULL)::int) = 1)
);--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_organization_id" ON "storage" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_project_id" ON "storage" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_environment_id" ON "storage" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_service_id" ON "storage" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_server_id" ON "storage" USING btree ("server_id" uuid_ops);
