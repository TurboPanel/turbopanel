-- Off by default: each organization opts in to Let's Encrypt itself.
-- Organizations made before this column keep what options.acmeEnabled said.
ALTER TABLE "organization" ADD COLUMN "is_acme_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "organization" SET "is_acme_enabled" = true WHERE "options"->'acmeEnabled' = 'true'::jsonb;--> statement-breakpoint
COMMENT ON COLUMN "organization"."options" IS 'Org-wide settings merged key-by-key by the organization routes (`maxServers`, `phpModes` and more); its `acmeEnabled` only copies `is_acme_enabled`.';--> statement-breakpoint
COMMENT ON COLUMN "organization"."is_acme_enabled" IS 'Let''s Encrypt allowed for this organization''s certificates; off until the organization opts in. Turning it off erases stored keys but revokes nothing.';
