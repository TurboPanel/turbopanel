CREATE TABLE "principal_entitlement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"series" text NOT NULL,
	"granted_by" text DEFAULT 'operator' NOT NULL,
	CONSTRAINT "principal_entitlement_unique" UNIQUE("principal_id","runtime","series"),
	CONSTRAINT "principal_entitlement_runtime_check" CHECK ("principal_entitlement"."runtime" IN ('php', 'node')),
	CONSTRAINT "principal_entitlement_series_check" CHECK ("principal_entitlement"."series" ~ '^[0-9]{1,3}([.][0-9]{1,3})?$'),
	CONSTRAINT "principal_entitlement_granted_by_check" CHECK ("principal_entitlement"."granted_by" IN ('operator', 'deploy'))
);
--> statement-breakpoint
ALTER TABLE "principal_entitlement" ADD CONSTRAINT "principal_entitlement_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_principal_entitlement_principal_id" ON "principal_entitlement" USING btree ("principal_id" uuid_ops);