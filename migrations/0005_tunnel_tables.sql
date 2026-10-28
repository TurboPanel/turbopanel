-- Tunnels: five new tables (carrier, badge, tunnel, portal, doorway) that hold
-- provider accounts, their API tokens (sealed in the existing secret table, never
-- here), tunnels, the servers running them and the hostnames they carry. Additive:
-- nothing existing is dropped or rewritten, and the previous release never reads
-- them. The one change to an existing object widens secret_provider_check with the
-- two token providers; every value the previous release writes stays allowed.
CREATE TABLE "badge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"carrier_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"label" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_four" text NOT NULL,
	"last_checked_at" timestamp(3) with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "uniq_badge_secret_id" UNIQUE("secret_id"),
	CONSTRAINT "badge_status_check" CHECK (status IN ('active', 'attention'))
);
--> statement-breakpoint
CREATE TABLE "carrier" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"external_account_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "uniq_carrier_organization_id_provider_external_account_id" UNIQUE("organization_id","provider","external_account_id"),
	CONSTRAINT "carrier_provider_check" CHECK (provider IN ('cloudflare')),
	CONSTRAINT "carrier_status_check" CHECK (status IN ('active', 'attention'))
);
--> statement-breakpoint
CREATE TABLE "doorway" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"routing_organization_id" uuid NOT NULL,
	"tunnel_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"kind" text DEFAULT 'http' NOT NULL,
	"hosting_id" uuid,
	"external_route_id" text,
	"external_dns_record_id" text,
	"is_local_only" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "uniq_doorway_tunnel_id_hostname" UNIQUE("tunnel_id","hostname"),
	CONSTRAINT "doorway_kind_check" CHECK (kind IN ('http')),
	CONSTRAINT "doorway_status_check" CHECK (status IN ('pending', 'live', 'attention', 'removing'))
);
--> statement-breakpoint
CREATE TABLE "portal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"tunnel_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"wanted" text DEFAULT 'run' NOT NULL,
	"reported" text DEFAULT 'unknown' NOT NULL,
	"last_seen_at" timestamp(3) with time zone,
	"last_error" text,
	"connector_version" text,
	"version_checked_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_portal_tunnel_id_server_id" UNIQUE("tunnel_id","server_id"),
	CONSTRAINT "portal_wanted_check" CHECK (wanted IN ('run', 'skip')),
	CONSTRAINT "portal_reported_check" CHECK (reported IN ('unknown', 'connected', 'down', 'error'))
);
--> statement-breakpoint
CREATE TABLE "tunnel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"routing_organization_id" uuid NOT NULL,
	"carrier_id" uuid,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"placement" text DEFAULT 'chosen' NOT NULL,
	"datacenter_id" uuid,
	"secret_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "uniq_tunnel_organization_id_name" UNIQUE("organization_id","name"),
	CONSTRAINT "tunnel_provider_check" CHECK (provider IN ('cloudflare')),
	CONSTRAINT "tunnel_placement_check" CHECK (placement IN ('one', 'chosen', 'all')),
	CONSTRAINT "tunnel_status_check" CHECK (status IN ('pending', 'active', 'attention', 'removing'))
);
--> statement-breakpoint
ALTER TABLE "secret" DROP CONSTRAINT "secret_provider_check";--> statement-breakpoint
ALTER TABLE "badge" ADD CONSTRAINT "badge_carrier_id_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carrier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge" ADD CONSTRAINT "badge_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorway" ADD CONSTRAINT "doorway_routing_organization_id_organization_id_fk" FOREIGN KEY ("routing_organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorway" ADD CONSTRAINT "doorway_tunnel_id_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorway" ADD CONSTRAINT "doorway_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal" ADD CONSTRAINT "portal_tunnel_id_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal" ADD CONSTRAINT "portal_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_routing_organization_id_organization_id_fk" FOREIGN KEY ("routing_organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_carrier_id_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carrier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_badge_carrier_id" ON "badge" USING btree ("carrier_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_carrier_organization_id" ON "carrier" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_doorway_routing_organization_id_hostname" ON "doorway" USING btree ("routing_organization_id" uuid_ops,"hostname" text_ops);--> statement-breakpoint
CREATE INDEX "idx_doorway_hosting_id" ON "doorway" USING btree ("hosting_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_portal_server_id" ON "portal" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tunnel_routing_organization_id" ON "tunnel" USING btree ("routing_organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tunnel_carrier_id" ON "tunnel" USING btree ("carrier_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tunnel_datacenter_id" ON "tunnel" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_provider_check" CHECK (provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key', 'cloudflare', 'cloudflare_tunnel'));--> statement-breakpoint
COMMENT ON TABLE "badge" IS 'One API token on a carrier; the token itself is sealed in the `secret` row it points to and this row keeps the label, last four characters and what it can do.';--> statement-breakpoint
COMMENT ON COLUMN "badge"."secret_id" IS 'The sealed token in `secret`, one badge per secret and not deletable under it; removing the badge removes the secret in the same transaction.';--> statement-breakpoint
COMMENT ON COLUMN "badge"."label" IS 'Operator label for the token, shown beside its last four characters.';--> statement-breakpoint
COMMENT ON COLUMN "badge"."capabilities" IS 'What the last check found the token can do: `tunnels`, `dns` and `certificates` as booleans, written by the panel after each check.';--> statement-breakpoint
COMMENT ON COLUMN "badge"."last_four" IS 'Last 4 characters of the token, the only part of it ever shown; never enough to use the token.';--> statement-breakpoint
COMMENT ON COLUMN "badge"."last_checked_at" IS 'When the panel last checked the token with the provider; NULL until then.';--> statement-breakpoint
COMMENT ON COLUMN "badge"."status" IS '`active` while the last check succeeded, `attention` once a check was refused or failed.';--> statement-breakpoint
COMMENT ON TABLE "carrier" IS 'A provider account an organization connected for tunnels; its API tokens are `badge` rows and nothing secret is stored here.';--> statement-breakpoint
COMMENT ON COLUMN "carrier"."metadata" IS 'Non-secret descriptors written by the panel; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "carrier"."options" IS 'Provider-specific non-secret details from the provider (for example the account name); no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "carrier"."provider" IS 'Tunnel provider, `cloudflare` for now; widened by a forward migration.';--> statement-breakpoint
COMMENT ON COLUMN "carrier"."name" IS 'Operator label for the account; unique only together with the provider and account id.';--> statement-breakpoint
COMMENT ON COLUMN "carrier"."external_account_id" IS 'The provider own account id; NULL for a provider with no account concept (rows with NULL never collide).';--> statement-breakpoint
COMMENT ON COLUMN "carrier"."status" IS '`active` while a token on it works, `attention` when none does.';--> statement-breakpoint
COMMENT ON TABLE "doorway" IS 'One hostname a tunnel carries to a site, with the provider route and DNS record ids; global uniqueness stays with `hostname`, here a name is unique per tunnel.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."metadata" IS 'Non-secret descriptors written by the panel; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."options" IS 'Provider-specific route details; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."routing_organization_id" IS 'Organization whose servers answer for this name, named as on `hostname`; indexed with the name for lookups.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."hostname" IS 'Lower-case DNS name the tunnel carries; also registered in `hostname` through the hosting.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."kind" IS 'Kind of traffic carried, `http` for now; ssh, rdp, vnc and tcp are added by a forward migration.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."hosting_id" IS 'The site this name serves; SET NULL when the site is deleted, leaving the doorway unattached.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."external_route_id" IS 'The provider id of the route for this name; NULL until published.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."external_dns_record_id" IS 'The provider id of the DNS record the panel created for this name; NULL until created.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."is_local_only" IS 'True (the default) when the web server answers this name only for the local connector and datacenter peers.';--> statement-breakpoint
COMMENT ON COLUMN "doorway"."status" IS '`pending` until route and DNS name exist, `live`, `attention` after a provider error, `removing` while being taken down.';--> statement-breakpoint
COMMENT ON TABLE "portal" IS 'A server part in a tunnel: it runs a connector (`run`) or is left out (`skip`), with the connector state the server last reported.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."metadata" IS 'Non-secret descriptors written by the panel; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."options" IS 'Per-server details such as a local endpoint; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."wanted" IS '`run` when the server carries a connector, `skip` when an `all` tunnel leaves it out; `chosen` is the `run` rows.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."reported" IS 'What the server last reported: `unknown` (default), `connected`, `down` or `error`.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."last_seen_at" IS 'When the server last reported on the connector; NULL until the first report.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."last_error" IS 'Plain-words error from the last failed report; NULL when none.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."connector_version" IS 'Version of the connector program the daemon reports running here; NULL until the first report.';--> statement-breakpoint
COMMENT ON COLUMN "portal"."version_checked_at" IS 'When the daemon last reported the connector version; NULL until then.';--> statement-breakpoint
COMMENT ON COLUMN "secret"."provider" IS '`s3`, `s3_compatible`, `nfs`, `cifs`, `sftp`, `ftp`, `webdav` (reserved), `git_deploy_key`, or `cloudflare` and `cloudflare_tunnel` (tunnel tokens).';--> statement-breakpoint
COMMENT ON TABLE "tunnel" IS 'A tunnel an organization created: a named path from a provider edge to connectors on its servers; the sealed run token is a `secret` row.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."metadata" IS 'Non-secret descriptors written by the panel; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."options" IS 'Provider-specific tunnel settings; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."routing_organization_id" IS 'Organization whose servers and sites the tunnel carries; equal to `organization_id` for now, enforced in code only.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."provider" IS 'Tunnel provider, `cloudflare` for now; widened by a forward migration.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."name" IS 'Operator name, unique per organization.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."external_id" IS 'The provider own tunnel id; NULL until the provider created it.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."placement" IS '`one` (exactly one `run` portal), `chosen` (the `run` portals) or `all` (every server of the datacenter except the `skip` portals).';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."secret_id" IS 'The sealed run token in `secret`; SET NULL if that row goes, NULL for a provider that needs none.';--> statement-breakpoint
COMMENT ON COLUMN "tunnel"."status" IS '`pending` until created, `active`, `attention` after a provider error, `removing` while being taken down.';
