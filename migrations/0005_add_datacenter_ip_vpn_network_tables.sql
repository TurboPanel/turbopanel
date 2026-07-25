CREATE TABLE "datacenter" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" varchar(255),
	"description" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "datacenter_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "ip" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"network_id" uuid,
	"server_id" uuid,
	"address" "inet" NOT NULL,
	"version" integer NOT NULL,
	"allocation" text NOT NULL,
	"scope" text NOT NULL,
	"display_name" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "ip_version_check" CHECK (version IN (4, 6)),
	CONSTRAINT "ip_allocation_check" CHECK (allocation IN ('dedicated', 'shared')),
	CONSTRAINT "ip_scope_check" CHECK (scope IN ('public', 'datacenter', 'loopback')),
	CONSTRAINT "ip_version_matches_address_check" CHECK (version = family(address)),
	CONSTRAINT "ip_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "peer" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"vpn_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"ip_id" uuid,
	"public_key" text NOT NULL,
	"tunnel_address" "inet",
	"listen_port" integer,
	"endpoint" varchar(255),
	"preshared_key" text,
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "peer_vpn_server_unique" UNIQUE("vpn_id","server_id"),
	CONSTRAINT "peer_vpn_public_key_unique" UNIQUE("vpn_id","public_key")
);
--> statement-breakpoint
CREATE TABLE "vpn" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"network_id" uuid,
	"display_name" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "vpn_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
ALTER TABLE "network" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hosting" ADD COLUMN "ip_id" uuid;--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "datacenter_id" uuid;--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "cidr" "cidr";--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "options" jsonb;--> statement-breakpoint
UPDATE "network" SET "organization_id" = s."organization_id" FROM "server" s WHERE s."id" = "network"."server_id";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "network" WHERE "organization_id" IS NULL) THEN
    RAISE EXCEPTION 'network.organization_id backfill left NULL rows (server.organization_id missing or orphan network rows)';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "network" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
UPDATE "network" SET "kind" = 'server' WHERE "kind" IS NULL;--> statement-breakpoint
ALTER TABLE "network" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_kind_check" CHECK (kind IN ('datacenter', 'server', 'docker', 'vpn'));--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_single_scope_check" CHECK (NOT (("network"."datacenter_id" IS NOT NULL) AND ("network"."server_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "datacenter_id" uuid;--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer" ADD CONSTRAINT "peer_vpn_id_vpn_id_fk" FOREIGN KEY ("vpn_id") REFERENCES "public"."vpn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer" ADD CONSTRAINT "peer_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer" ADD CONSTRAINT "peer_ip_id_ip_id_fk" FOREIGN KEY ("ip_id") REFERENCES "public"."ip"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn" ADD CONSTRAINT "vpn_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn" ADD CONSTRAINT "vpn_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_datacenter_organization_id" ON "datacenter" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_organization_id" ON "ip" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_datacenter_id" ON "ip" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_network_id" ON "ip" USING btree ("network_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_server_id" ON "ip" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ip_org_address" ON "ip" USING btree ("organization_id","address");--> statement-breakpoint
CREATE INDEX "idx_peer_vpn_id" ON "peer" USING btree ("vpn_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_peer_server_id" ON "peer" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_peer_ip_id" ON "peer" USING btree ("ip_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_vpn_organization_id" ON "vpn" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_vpn_network_id" ON "vpn" USING btree ("network_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_ip_id_ip_id_fk" FOREIGN KEY ("ip_id") REFERENCES "public"."ip"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hosting_ip_id" ON "hosting" USING btree ("ip_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_organization_id" ON "network" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_datacenter_id" ON "network" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_datacenter_id" ON "server" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)));