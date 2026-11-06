ALTER TABLE "fabric" ADD COLUMN "is_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "relay" ADD COLUMN "kind" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "is_fabric_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "fabric_role" text;--> statement-breakpoint
ALTER TABLE "relay" ADD CONSTRAINT "relay_kind_check" CHECK (kind IN ('server', 'external'));--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_fabric_role_check" CHECK (fabric_role IS NULL OR fabric_role IN ('gateway', 'client'));--> statement-breakpoint
COMMENT ON TABLE "fabric" IS 'Org TurboFabric WireGuard mesh (`tp0`), at most one row per organization; absent means off, `is_enabled = false` means paused; never holds private keys.';--> statement-breakpoint
COMMENT ON COLUMN "fabric"."is_enabled" IS 'False while the mesh is paused: every tunnel is down but relays, keys and container networks are kept so turning it back on is instant.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."kind" IS 'Peer kind, `server` (an org server, the only kind built) or `external` (reserved for a person''s device; nothing writes it yet).';--> statement-breakpoint
COMMENT ON COLUMN "server"."is_fabric_enabled" IS 'TurboFabric membership switch, default true; false keeps the server out of the mesh (no relay, no `tp0`, no peer entry, no fabric address).';--> statement-breakpoint
COMMENT ON COLUMN "server"."fabric_role" IS 'Operator TurboFabric role, `gateway` (accepts connections) or `client` (only dials out); NULL means automatic, gateway when a public address is known.';
