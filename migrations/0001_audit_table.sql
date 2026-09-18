CREATE TABLE "audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"context" jsonb
);
--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_organization_created" ON "audit" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_target" ON "audit" USING btree ("target_type","target_id");