CREATE TABLE "allowance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "allowance_quantity_check" CHECK (quantity >= 1)
);
--> statement-breakpoint
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_tier_id_tier_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."tier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_allowance_organization" ON "allowance" USING btree ("organization_id");