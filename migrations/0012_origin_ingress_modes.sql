CREATE TABLE "ingress" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"account_id" text,
	"zone_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_envelope" text NOT NULL,
	"scopes" jsonb,
	"last_verified_at" timestamp(3) with time zone,
	"last_error" text,
	"created_by_user_id" uuid,
	CONSTRAINT "ingress_provider_check" CHECK (provider IN ('cloudflare', 'bunny'))
);
--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "mode" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "public_port" integer DEFAULT 8443 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "is_daemon_dial" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "ingress_id" uuid;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "ingress_state" jsonb;--> statement-breakpoint
ALTER TABLE "ingress" ADD CONSTRAINT "ingress_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_ingress_id_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "public"."ingress"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_origin_ingress_id" ON "origin" USING btree ("ingress_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_origin_primary" ON "origin" USING btree ("is_primary") WHERE is_primary;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_mode_check" CHECK (mode IN ('direct', 'lan-only', 'cloudflare-tunnel', 'cloudflare-proxy', 'bunny-proxy', 'private-overlay', 'passthrough'));--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_public_port_check" CHECK (public_port BETWEEN 1 AND 65535);--> statement-breakpoint
COMMENT ON TABLE "ingress" IS 'One install-level provider account for the control plane''s own names, used by edge modes for tunnels, DNS and certificates.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."provider" IS 'Provider of this account: `cloudflare` or `bunny`.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."label" IS 'Operator-chosen name shown in the admin screens.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."account_id" IS 'Provider account id (for example the Cloudflare account); NULL when the provider has none.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."zone_ids" IS 'JSON array of provider zone ids this account may change, written by the superadmin who adds it.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."token_envelope" IS 'Provider API token sealed as a `tpsecret` envelope; held inline because `secret` requires an organization, and never returned by the admin API.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."scopes" IS 'Last preflight result written by the panel: whether the token can manage tunnels and DNS, and when it was checked.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."last_verified_at" IS 'When the panel last confirmed the token works; NULL until a check runs.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."last_error" IS 'Last provider error for this account; NULL when the last check succeeded.';--> statement-breakpoint
COMMENT ON COLUMN "ingress"."created_by_user_id" IS 'Superadmin who added this account; NULL after that user is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."mode" IS 'How visitors reach this name: `direct`, `lan-only`, `cloudflare-tunnel`, `cloudflare-proxy`, `bunny-proxy`, `private-overlay` or `passthrough`.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."public_port" IS 'Port visitors use for this name (1 to 65535); the control plane itself always listens on 8443.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."is_primary" IS 'True for the one name used for links, sign-in callbacks and the default install URL; a partial unique index allows at most one row.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."is_daemon_dial" IS 'Whether install commands and the daemon URL list may name this hostname; false keeps it for people only.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."ingress_state" IS 'Provider state for this name, such as tunnel id, DNS record id and last status; the shape depends on `mode` and the provider writes it.';
