-- Added as false so organizations made before this column keep what
-- options.acmeEnabled said (a missing key meant off); then new organizations
-- default to on.
ALTER TABLE "organization" ADD COLUMN "is_acme_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "organization" SET "is_acme_enabled" = true WHERE "options"->'acmeEnabled' = 'true'::jsonb;--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "is_acme_enabled" SET DEFAULT true;--> statement-breakpoint
COMMENT ON COLUMN "organization"."options" IS 'Org-wide settings merged key-by-key by the organization routes (`maxServers`, `phpModes` and more); its `acmeEnabled` only copies `is_acme_enabled`.';--> statement-breakpoint
COMMENT ON COLUMN "organization"."is_acme_enabled" IS 'Let''s Encrypt allowed for this organization''s certificates; new organizations start on. Turning it off erases stored Let''s Encrypt keys but revokes nothing.';
