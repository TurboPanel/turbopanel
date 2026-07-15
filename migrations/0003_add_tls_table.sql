CREATE TABLE "tls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" varchar(255),
	"source" text NOT NULL,
	"certificate_pem" text,
	"private_key_pem" text,
	"metadata" jsonb NOT NULL,
	"options" jsonb,
	CONSTRAINT "tls_source_check" CHECK (source IN ('upload', 'lets_encrypt', 'self_signed')),
	CONSTRAINT "tls_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
ALTER TABLE "hosting" ADD COLUMN "tls_id" uuid;--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tls_organization_id" ON "tls" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_tls_id_tls_id_fk" FOREIGN KEY ("tls_id") REFERENCES "public"."tls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hosting_tls_id" ON "hosting" USING btree ("tls_id" uuid_ops);