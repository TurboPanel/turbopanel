CREATE TABLE IF NOT EXISTS "license" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" varchar(255),
	"hashed_token" text NOT NULL,
	"revoked_at" timestamp(3) with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server" ADD COLUMN "license_id" uuid;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "license" ADD CONSTRAINT "license_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_license_organization_id" ON "license" USING btree ("organization_id" uuid_ops);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server" ADD CONSTRAINT "server_license_id_license_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."license"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
