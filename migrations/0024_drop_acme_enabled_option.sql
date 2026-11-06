-- The Let's Encrypt switch lives in organization.is_acme_enabled. Copy the
-- old options.acmeEnabled key into the column once more (a build rolled back
-- onto the database may have written only the key), then remove the key so
-- nothing can read it again.
UPDATE "organization" SET "is_acme_enabled" = ("options"->'acmeEnabled' = 'true'::jsonb) WHERE "options" ? 'acmeEnabled';--> statement-breakpoint
UPDATE "organization" SET "options" = "options" - 'acmeEnabled' WHERE "options" ? 'acmeEnabled';--> statement-breakpoint
COMMENT ON COLUMN "organization"."options" IS 'Org-wide settings merged key-by-key by the organization routes (`maxServers`, `phpModes` and more).';
