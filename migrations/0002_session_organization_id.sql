ALTER TABLE "session" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_organization_id" ON "session" USING btree ("organization_id" uuid_ops);
