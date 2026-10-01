CREATE TABLE "bulwark" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"mode" text DEFAULT 'observe' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"last_digest" text,
	"last_result" jsonb,
	"state" text DEFAULT 'idle' NOT NULL,
	"deadline_at" timestamp(3) with time zone,
	"last_applied_at" timestamp(3) with time zone,
	"confirmed_at" timestamp(3) with time zone,
	CONSTRAINT "bulwark_mode_check" CHECK (mode IN ('observe', 'managed', 'off')),
	CONSTRAINT "bulwark_state_check" CHECK (state IN ('idle', 'pending', 'confirmed', 'rolled_back')),
	CONSTRAINT "bulwark_generation_check" CHECK (generation >= 0),
	CONSTRAINT "bulwark_digest_format_check" CHECK (last_digest IS NULL OR last_digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "edict" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"label" text NOT NULL,
	"scope" text NOT NULL,
	"action" text NOT NULL,
	"proto" text NOT NULL,
	"ports" text,
	"source_kind" text NOT NULL,
	"source_addresses" "inet"[] DEFAULT '{}'::inet[] NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "edict_scope_check" CHECK (scope IN ('host', 'published')),
	CONSTRAINT "edict_action_check" CHECK (action IN ('accept', 'drop', 'reject')),
	CONSTRAINT "edict_proto_check" CHECK (proto IN ('tcp', 'udp', 'any')),
	CONSTRAINT "edict_source_kind_check" CHECK (source_kind IN ('any', 'servers', 'datacenter', 'fabric', 'addresses')),
	CONSTRAINT "edict_label_format_check" CHECK (label ~ '^[A-Za-z0-9 ._:/-]{1,48}$'),
	CONSTRAINT "edict_ports_format_check" CHECK (ports IS NULL OR ports ~ '^[0-9]{1,5}(-[0-9]{1,5})?$'),
	CONSTRAINT "edict_ports_proto_check" CHECK (ports IS NULL OR proto <> 'any'),
	CONSTRAINT "edict_accept_ports_check" CHECK (action <> 'accept' OR ports IS NOT NULL),
	CONSTRAINT "edict_source_addresses_check" CHECK ((source_kind = 'addresses' AND cardinality(source_addresses) BETWEEN 1 AND 256) OR (source_kind <> 'addresses' AND cardinality(source_addresses) = 0))
);
--> statement-breakpoint
ALTER TABLE "bulwark" ADD CONSTRAINT "bulwark_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edict" ADD CONSTRAINT "edict_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edict" ADD CONSTRAINT "edict_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edict" ADD CONSTRAINT "edict_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bulwark_server_id" ON "bulwark" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_edict_organization_id" ON "edict" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_edict_server_id" ON "edict" USING btree ("server_id");
--> statement-breakpoint
COMMENT ON TABLE "bulwark" IS 'One server''s firewall state: its mode, the generation last sent, what the host last answered, and whether the last ruleset was kept.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."server_id" IS 'The server this state belongs to; one row per server, cascade-deleted with it.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."mode" IS '`observe` shows the ruleset and applies nothing (the default), `managed` enforces it and `off` leaves the firewall alone.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."generation" IS 'Rises by one each time the desired ruleset changes, so a host can tell a stale push from a current one.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_digest" IS 'The sha256 hex the host last reported for its rendered rulesets; the drift key.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_result" IS 'What the host last answered: applied or refused, the rule count and any warnings; null before any report.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."state" IS '`idle`, `pending` (awaiting confirmation), `confirmed` or `rolled_back` (undone by the host guard).';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."deadline_at" IS 'When the host guard undoes an unconfirmed ruleset; null unless `state` is `pending`.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_applied_at" IS 'When the host last applied a ruleset; null before the first.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."confirmed_at" IS 'When the last ruleset was confirmed as keeping the host reachable; null before the first.';--> statement-breakpoint
COMMENT ON TABLE "edict" IS 'One firewall rule an operator typed, in the wire contract words; rules derived from what is deployed are computed per server and never stored here.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."organization_id" IS 'Owning organization; cascade-deletes the rule with the org.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."server_id" IS 'The one server the rule applies to; null means every server in the organization.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."label" IS 'Operator label shown in the console, also sent to the host as the rule''s comment, so it uses the comment alphabet.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."scope" IS '`host` for the host''s own listeners or `published` for a port Docker publishes for a container.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."action" IS '`accept` allows, `drop` blocks silently and `reject` blocks and tells the sender.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."proto" IS '`tcp`, `udp` or `any`; ports are meaningful only for `tcp` and `udp`.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."ports" IS 'One port or an inclusive ascending range such as `5432-5440`; null means every port, which only a block may say.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."source_kind" IS 'Who the rule is about: `any`, `servers` (the organization''s other servers), `datacenter`, `fabric` or `addresses`.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."source_addresses" IS 'Explicit addresses or CIDRs, one to 256 of them; only for `source_kind` `addresses`, empty for every other kind.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."is_enabled" IS 'False keeps the rule but leaves it out of the ruleset sent to hosts.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."created_by" IS 'User who created the rule; null once that user is deleted.';
