-- Groundwork tables and columns for features that follow: three new tables
-- (record, peripheral, visitor) and seven new columns on existing tables
-- (server.role, service.is_host_access_allowed, placement.sync_device_id and
-- sync_port, backup.origin, archive.origin, channel.is_all_organizations_notified).
-- Additive: nothing existing is dropped or rewritten; every new column is
-- nullable or has a default that keeps existing rows meaning what they meant,
-- and the previous release never reads any of them.
-- record_carrier_id_carrier_id_fk is DEFERRABLE INITIALLY DEFERRED (drizzle
-- cannot express it), like tunnel_carrier_id_carrier_id_fk: an organization
-- delete that removes the carrier and its records succeeds, while deleting a
-- carrier that still has records fails at commit.
CREATE TABLE "record" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"carrier_id" uuid,
	"ingress_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"zone_id" text NOT NULL,
	"external_id" text,
	"content" text NOT NULL,
	"ttl" integer,
	"checked_at" timestamp(3) with time zone,
	"error" text,
	"is_proxied" boolean DEFAULT false NOT NULL,
	"is_adopted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_record_scope_name_kind_content" UNIQUE NULLS NOT DISTINCT("organization_id","name","kind","content"),
	CONSTRAINT "record_kind_check" CHECK (kind IN ('A', 'AAAA', 'CNAME')),
	CONSTRAINT "record_status_check" CHECK (status IN ('pending', 'synced', 'drifted', 'removing', 'failed')),
	CONSTRAINT "record_provider_check" CHECK (provider IN ('cloudflare')),
	CONSTRAINT "record_account_check" CHECK (num_nonnulls(carrier_id, ingress_id) = 1),
	CONSTRAINT "record_scope_check" CHECK ((organization_id IS NULL) = (carrier_id IS NULL)),
	CONSTRAINT "record_name_check" CHECK (name = lower(name) AND char_length(name) BETWEEN 1 AND 253),
	CONSTRAINT "record_ttl_check" CHECK (ttl IS NULL OR ttl BETWEEN 1 AND 86400)
);
--> statement-breakpoint
CREATE TABLE "peripheral" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"service_id" uuid,
	"name" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'present' NOT NULL,
	"path" text NOT NULL,
	"vendor_id" text,
	"product_id" text,
	"observed_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_peripheral_server_path" UNIQUE("server_id","path"),
	CONSTRAINT "peripheral_kind_check" CHECK (kind IN ('usb', 'serial', 'printer', 'video', 'audio', 'other')),
	CONSTRAINT "peripheral_status_check" CHECK (status IN ('present', 'missing')),
	CONSTRAINT "peripheral_path_check" CHECK (path ~ '^/dev/[A-Za-z0-9._:/+-]+$' AND path !~ '\.\.'),
	CONSTRAINT "peripheral_vendor_id_check" CHECK (vendor_id IS NULL OR vendor_id ~ '^[0-9a-f]{4}$'),
	CONSTRAINT "peripheral_product_id_check" CHECK (product_id IS NULL OR product_id ~ '^[0-9a-f]{4}$')
);
--> statement-breakpoint
CREATE TABLE "visitor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	CONSTRAINT "uniq_visitor_service_name" UNIQUE("service_id","name"),
	CONSTRAINT "visitor_name_check" CHECK (name ~ '^[A-Za-z0-9._@-]{1,64}$'),
	CONSTRAINT "visitor_password_hash_check" CHECK (password_hash ~ '^\$2y\$1[0-2]\$[./A-Za-z0-9]{53}$')
);
--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "origin" text DEFAULT 'backup' NOT NULL;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN "origin" text DEFAULT 'backup' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "is_all_organizations_notified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "sync_device_id" text;--> statement-breakpoint
ALTER TABLE "placement" ADD COLUMN "sync_port" integer;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "role" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "is_host_access_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_carrier_id_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carrier"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_ingress_id_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "public"."ingress"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral" ADD CONSTRAINT "peripheral_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral" ADD CONSTRAINT "peripheral_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor" ADD CONSTRAINT "visitor_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_record_provider_zone_external" ON "record" USING btree ("provider","zone_id","external_id") WHERE "record"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_record_carrier_id" ON "record" USING btree ("carrier_id") WHERE "record"."carrier_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_record_ingress_id" ON "record" USING btree ("ingress_id") WHERE "record"."ingress_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_record_open" ON "record" USING btree ("updated_at") WHERE "record"."status" <> 'synced';--> statement-breakpoint
CREATE INDEX "idx_peripheral_service_id" ON "peripheral" USING btree ("service_id") WHERE "peripheral"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_placement_server_sync_port" ON "placement" USING btree ("server_id","sync_port") WHERE "placement"."sync_port" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_origin_check" CHECK (origin IN ('backup', 'import'));--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_origin_check" CHECK (origin IN ('backup', 'import'));--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_all_organizations_check" CHECK (NOT is_all_organizations_notified OR scope = 'instance');--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_sync_device_id_check" CHECK (sync_device_id IS NULL OR sync_device_id ~ '^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$');--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_sync_port_check" CHECK (sync_port IS NULL OR sync_port BETWEEN 1024 AND 65535);--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_role_check" CHECK (role IN ('server', 'witness'));--> statement-breakpoint
COMMENT ON COLUMN "archive"."origin" IS '`backup` when a backup run made the file, `import` when it was brought in to be restored; existing rows are `backup`.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."origin" IS '`backup` when a backup run made the file, `import` when it was brought in to be restored; existing rows are `backup`.';--> statement-breakpoint
COMMENT ON TABLE "record" IS 'A DNS record TurboPanel created or adopted at a connected provider, so it never changes a record it does not own.';--> statement-breakpoint
COMMENT ON COLUMN "record"."organization_id" IS 'Organization whose name it is; NULL for the control plane own names, which use an `ingress` account.';--> statement-breakpoint
COMMENT ON COLUMN "record"."carrier_id" IS 'Organization provider account that serves it; checked at commit so an organization delete removes both.';--> statement-breakpoint
COMMENT ON COLUMN "record"."ingress_id" IS 'Install-level provider account for the control plane own names; set exactly when `carrier_id` is not.';--> statement-breakpoint
COMMENT ON COLUMN "record"."name" IS 'Fully qualified record name in lower case.';--> statement-breakpoint
COMMENT ON COLUMN "record"."kind" IS 'Record type: `A`, `AAAA` or `CNAME`.';--> statement-breakpoint
COMMENT ON COLUMN "record"."status" IS '`pending`, `synced`, `drifted`, `removing` or `failed`, as the drift check last found it.';--> statement-breakpoint
COMMENT ON COLUMN "record"."provider" IS 'Provider that holds the record; `cloudflare` only for now.';--> statement-breakpoint
COMMENT ON COLUMN "record"."zone_id" IS 'Provider zone id the record lives in.';--> statement-breakpoint
COMMENT ON COLUMN "record"."external_id" IS 'Provider record id; NULL until the provider created it, unique per provider zone.';--> statement-breakpoint
COMMENT ON COLUMN "record"."content" IS 'Record value: an address for `A` and `AAAA`, a host name for `CNAME`.';--> statement-breakpoint
COMMENT ON COLUMN "record"."ttl" IS 'Time to live in seconds, 1 to 86400; NULL leaves the provider automatic value.';--> statement-breakpoint
COMMENT ON COLUMN "record"."checked_at" IS 'When the drift check last compared the record with the provider.';--> statement-breakpoint
COMMENT ON COLUMN "record"."error" IS 'Last provider error in plain words; NULL after a success.';--> statement-breakpoint
COMMENT ON COLUMN "record"."is_proxied" IS 'Whether the provider proxy fronts the record, as for a tunnel `CNAME`.';--> statement-breakpoint
COMMENT ON COLUMN "record"."is_adopted" IS 'True when the record already existed at the provider and an owner adopted it.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."is_all_organizations_notified" IS 'Instance channels only: also hear every organization event, including organizations created later; otherwise only install events.';--> statement-breakpoint
COMMENT ON TABLE "peripheral" IS 'A device node on a server that can be passed to one service (USB drive, serial adapter, printer, capture card), keyed by its stable path.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."service_id" IS 'The service the device is passed to; NULL when no service has it, and cleared when that service is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."name" IS 'Label an operator gave the device; NULL when none.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."kind" IS 'What the device is: `usb`, `serial`, `printer`, `video`, `audio` or `other`.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."status" IS '`present` while the host reports the device, `missing` once it no longer does.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."path" IS 'Stable device path under `/dev` (a by-id or by-path link) as the host reports it; unique per server.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."vendor_id" IS 'USB vendor id as four lower-case hex digits; NULL for a device that is not on USB.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."product_id" IS 'USB product id as four lower-case hex digits; NULL for a device that is not on USB.';--> statement-breakpoint
COMMENT ON COLUMN "peripheral"."observed_at" IS 'When the host last reported the device.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."sync_device_id" IS 'Device id of the account file sync instance on this server, as the daemon reports it; NULL while sync is off.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."sync_port" IS 'Listen port the control plane gave the account file sync instance on this server, 1024 to 65535; unique per server.';--> statement-breakpoint
COMMENT ON COLUMN "server"."role" IS 'What the server is for: `server` runs workloads, `witness` only votes in database failover and holds no data; written by an administrator.';--> statement-breakpoint
COMMENT ON COLUMN "service"."is_host_access_allowed" IS 'Whether the service may use host-level Compose fields such as devices and host networking; needs the organization switch on too; default false.';--> statement-breakpoint
COMMENT ON TABLE "visitor" IS 'One sign-in for a password-protected site: a name and a bcrypt hash the site web server checks, per site service; never returned by a route.';--> statement-breakpoint
COMMENT ON COLUMN "visitor"."name" IS 'User name a visitor types; letters, digits and `._@-`, 1 to 64 characters, unique per site.';--> statement-breakpoint
COMMENT ON COLUMN "visitor"."password_hash" IS 'bcrypt hash of the password (`$2y$`, cost 10 to 12) written by the control plane; the password itself is never stored.';
