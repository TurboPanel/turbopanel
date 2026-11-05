ALTER TABLE "server" ADD COLUMN "trust_pin_fingerprint" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "trust_pin_keyset" integer;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "trust_pin_reported_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "is_trust_pin_matching" boolean;--> statement-breakpoint
COMMENT ON COLUMN "server"."trust_pin_fingerprint" IS 'Control plane key fingerprint the server''s pin file holds, from its last signed pin report; empty when nothing is pinned, NULL until a report verifies.';--> statement-breakpoint
COMMENT ON COLUMN "server"."trust_pin_keyset" IS 'Key set number of that pin, from the same signed report.';--> statement-breakpoint
COMMENT ON COLUMN "server"."trust_pin_reported_at" IS 'When the last signed pin report verified.';--> statement-breakpoint
COMMENT ON COLUMN "server"."is_trust_pin_matching" IS 'Whether the reported pin named this control plane''s current or next key; false raises the pin mismatch alarm.';
