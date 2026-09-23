CREATE TABLE "origin" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"host" text NOT NULL,
	"source" text NOT NULL,
	"uploaded_cert_id" uuid,
	"acme_last_attempt_at" timestamp(3) with time zone,
	"acme_last_error" text,
	"not_after" timestamp(3) with time zone,
	CONSTRAINT "origin_host_unique" UNIQUE("host"),
	CONSTRAINT "origin_source_check" CHECK (source IN ('platform-ca', 'uploaded', 'lets-encrypt')),
	CONSTRAINT "origin_uploaded_cert_check" CHECK ((source <> 'uploaded') OR (uploaded_cert_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "certificate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"label" text NOT NULL,
	"cert_pem" text NOT NULL,
	"key_pem" text NOT NULL,
	"dns_names" jsonb NOT NULL,
	"not_after" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_uploaded_cert_id_certificate_id_fk" FOREIGN KEY ("uploaded_cert_id") REFERENCES "public"."certificate"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_origin_uploaded_cert_id" ON "origin" USING btree ("uploaded_cert_id" uuid_ops);--> statement-breakpoint
COMMENT ON TABLE "origin" IS 'One control-plane public name operators publish, with its certificate source and any Let''s Encrypt attempt state.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."host" IS 'Normalized public URL entry (origin, host, or host:port) in the form public URL parsing already stores.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."source" IS 'Certificate source for this name: `platform-ca`, `uploaded`, or `lets-encrypt`.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."uploaded_cert_id" IS 'Uploaded pair (`certificate.id`) this name serves; required when `source` is `uploaded`, otherwise NULL.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."acme_last_attempt_at" IS 'When this instance last tried Let''s Encrypt for this name; NULL until an attempt runs.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."acme_last_error" IS 'Last Let''s Encrypt error for this name; NULL when the last attempt succeeded or none has run.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."not_after" IS 'Leaf expiry for this name when known; NULL for `platform-ca` and for Let''s Encrypt before a leaf exists.';--> statement-breakpoint
COMMENT ON TABLE "certificate" IS 'Uploaded control-plane certificate pair; several origin rows may reference one pair when its names cover them.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."label" IS 'Operator-chosen name for the uploaded pair, shown in the admin certificate list.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."cert_pem" IS 'Public certificate PEM, chain allowed; the leaf is parsed for names and expiry when the pair is stored.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."key_pem" IS 'Private key PEM sealed as a `tpsecret` envelope; the admin API never returns it.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."dns_names" IS 'JSON array of DNS names and IP addresses parsed from the leaf, used to test which hostnames the pair covers.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."not_after" IS 'Leaf expiry copied from the parsed certificate when the pair is stored.';