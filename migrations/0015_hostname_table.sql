CREATE TABLE "hostname" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"hosting_id" uuid NOT NULL,
	"routing_organization_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	CONSTRAINT "uniq_hostname_routing_organization_id_hostname" UNIQUE("routing_organization_id","hostname")
);
--> statement-breakpoint
ALTER TABLE "hostname" ADD CONSTRAINT "hostname_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostname" ADD CONSTRAINT "hostname_routing_organization_id_organization_id_fk" FOREIGN KEY ("routing_organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hostname_hosting_id" ON "hostname" USING btree ("hosting_id" uuid_ops);