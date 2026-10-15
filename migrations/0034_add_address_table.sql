CREATE TABLE "address" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"datacenter_id" uuid,
	"hostname" varchar(253),
	"address_v4" "inet",
	"address_v6" "inet",
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "address_scope_check" CHECK (scope IN ('public', 'datacenter')),
	CONSTRAINT "address_datacenter_scope_check" CHECK (("address"."scope" = 'datacenter') = ("address"."datacenter_id" IS NOT NULL)),
	CONSTRAINT "address_v4_family_check" CHECK (family("address"."address_v4") = 4),
	CONSTRAINT "address_v6_family_check" CHECK (family("address"."address_v6") = 6)
);
--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_address_organization_id" ON "address" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_address_server_id" ON "address" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_address_datacenter_id" ON "address" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_address_server_public" ON "address" USING btree ("server_id") WHERE "address"."scope" = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_address_server_datacenter" ON "address" USING btree ("server_id","datacenter_id") WHERE "address"."datacenter_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_address_server_primary" ON "address" USING btree ("server_id") WHERE "address"."is_primary";--> statement-breakpoint
COMMENT ON TABLE "address" IS 'An address clients use to reach a server, set by an operator: one `public` entry per server and one per datacenter the server belongs to.';--> statement-breakpoint
COMMENT ON COLUMN "address"."metadata" IS 'Reserved for the last DNS check of `hostname`; nothing writes it yet.';--> statement-breakpoint
COMMENT ON COLUMN "address"."options" IS 'External port per listener under `ports` (`postgres`, `mysql`, `http`, `https`); absent = the listen port, null = not reachable here.';--> statement-breakpoint
COMMENT ON COLUMN "address"."organization_id" IS 'Organization that owns the server, copied from it on save; entries cascade away with the organization.';--> statement-breakpoint
COMMENT ON COLUMN "address"."server_id" IS 'The server this entry belongs to; entries cascade away when the server is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "address"."scope" IS 'Which side of the server this entry describes: `public`, or `datacenter` for one datacenter the server belongs to.';--> statement-breakpoint
COMMENT ON COLUMN "address"."datacenter_id" IS 'The datacenter whose address this entry names; set if and only if `scope = ''datacenter''`; cascades away with the datacenter.';--> statement-breakpoint
COMMENT ON COLUMN "address"."hostname" IS 'Optional DNS name clients type, lower case and always containing a dot; it fills connection strings and goes on the database certificate.';--> statement-breakpoint
COMMENT ON COLUMN "address"."address_v4" IS 'Optional IPv4 address clients use when it is not the server''s own, such as a router; NULL = the server''s own address on that side.';--> statement-breakpoint
COMMENT ON COLUMN "address"."address_v6" IS 'Optional IPv6 address clients use when it is not the server''s own; NULL = the server''s own address on that side.';--> statement-breakpoint
COMMENT ON COLUMN "address"."is_primary" IS 'True on the entry that fills the main connection string, at most one per server; with none marked the public entry is used.';
