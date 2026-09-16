ALTER TABLE "project" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_organization_id" ON "project" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_organization_name" ON "project" USING btree ("organization_id",lower(btrim(("name")::text))) WHERE name IS NOT NULL;