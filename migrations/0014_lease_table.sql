CREATE TABLE "lease" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"organization_id" uuid,
	"owner" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"cursor" jsonb,
	CONSTRAINT "uniq_lease_name_organization" UNIQUE NULLS NOT DISTINCT("name","organization_id")
);
--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;