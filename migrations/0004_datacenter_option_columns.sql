ALTER TABLE "datacenter" ADD COLUMN "priority" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "datacenter" ADD COLUMN "is_trusted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "datacenter" ADD COLUMN "address_preference" text DEFAULT 'ipv6' NOT NULL;--> statement-breakpoint
ALTER TABLE "datacenter" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_priority_check" CHECK (priority >= 0 AND priority <= 1000);--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_address_preference_check" CHECK (address_preference IN ('ipv6', 'ipv4'));--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_kind_check" CHECK (kind IS NULL OR kind IN ('lan', 'backplane', 'provider_private'));--> statement-breakpoint
-- breaking-ok: nothing is live before the fold, the three routing keys move out of options into columns
UPDATE "datacenter" SET
  "priority" = CASE
    WHEN jsonb_typeof("options"->'priority') = 'number'
      AND CASE WHEN ("options"->>'priority') ~ '^[0-9]{1,4}$' THEN ("options"->>'priority')::int <= 1000 ELSE false END
    THEN ("options"->>'priority')::int ELSE "priority" END,
  "is_trusted" = CASE
    WHEN jsonb_typeof("options"->'trusted') = 'boolean' THEN ("options"->>'trusted')::boolean ELSE "is_trusted" END,
  "address_preference" = CASE
    WHEN "options"->>'addressPreference' IN ('ipv6', 'ipv4') THEN "options"->>'addressPreference' ELSE "address_preference" END,
  "options" = "options" - 'priority' - 'trusted' - 'addressPreference'
WHERE jsonb_typeof("options") = 'object'
  AND ("options" ? 'priority' OR "options" ? 'trusted' OR "options" ? 'addressPreference');--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."priority" IS 'Routing-ladder rank among a server''s datacenters, 0 to 1000, lower wins, default 100 (API field `priority`).';--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."is_trusted" IS 'True when the operator controls the datacenter''s L2 (default); false keeps server-to-server traffic off it (API field `trusted`).';--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."address_preference" IS 'Address family tried first among a server''s pins here, `ipv6` (default) or `ipv4` (API field `options.addressPreference`).';--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."kind" IS 'What the network is: `lan`, `backplane` or `provider_private`; NULL means the operator never said.';
--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."options" IS 'Operator settings jsonb: `sshPort`, `ntp`, timezone defaults and the location override; the routing policy lives in real columns.';
