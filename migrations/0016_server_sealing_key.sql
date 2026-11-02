ALTER TABLE "server" ADD COLUMN "sealing_key_kid" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "sealing_key_pub" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "sealing_key_reported_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "plaintext_secrets_at" timestamp(3) with time zone;
--> statement-breakpoint
COMMENT ON COLUMN "server"."sealing_key_kid" IS 'Fingerprint of the daemon X25519 sealing key, set when it registers; decrypt answers are sealed to that key for daemons listing `daemon-sealed-secrets-v1`.';--> statement-breakpoint
COMMENT ON COLUMN "server"."sealing_key_pub" IS 'Base64url raw public half of the daemon sealing key, stored only after its signature verified against the daemon key; NULL until registered.';--> statement-breakpoint
COMMENT ON COLUMN "server"."sealing_key_reported_at" IS 'When the daemon last registered its sealing key; NULL until it does.';--> statement-breakpoint
COMMENT ON COLUMN "server"."plaintext_secrets_at" IS 'Last time the secrets decrypt route answered this server in plaintext, written at most hourly; the edge go-live gate reads it.';
