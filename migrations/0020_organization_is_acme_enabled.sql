-- Let's Encrypt is off until an organization opts in, which needs a contact
-- address and accepted terms. Organizations made before these columns keep
-- what options.acmeEnabled and options.acmeContactEmail said.
ALTER TABLE "organization" ADD COLUMN "is_acme_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "acme_contact_email" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "acme_terms_accepted_at" timestamp(3) with time zone;--> statement-breakpoint
UPDATE "organization" SET "is_acme_enabled" = true WHERE "options"->'acmeEnabled' = 'true'::jsonb;--> statement-breakpoint
UPDATE "organization" SET "acme_contact_email" = "options"->>'acmeContactEmail' WHERE char_length("options"->>'acmeContactEmail') BETWEEN 3 AND 254 AND "options"->>'acmeContactEmail' LIKE '%_@_%';--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_acme_contact_email_check" CHECK ("organization"."acme_contact_email" IS NULL OR (char_length("organization"."acme_contact_email") >= 3 AND char_length("organization"."acme_contact_email") <= 254 AND "organization"."acme_contact_email" LIKE '%_@_%'));--> statement-breakpoint
COMMENT ON COLUMN "organization"."options" IS 'Org-wide settings merged key-by-key by the organization routes (`maxServers`, `phpModes` and more); its `acmeEnabled` only copies `is_acme_enabled`.';--> statement-breakpoint
COMMENT ON COLUMN "organization"."is_acme_enabled" IS 'Let''s Encrypt allowed for this organization''s certificates; off until the organization opts in. Turning it off erases stored keys but revokes nothing.';--> statement-breakpoint
COMMENT ON COLUMN "organization"."acme_contact_email" IS 'Contact address on the organization''s Let''s Encrypt account, needed to turn it on; null means none.';--> statement-breakpoint
COMMENT ON COLUMN "organization"."acme_terms_accepted_at" IS 'When the organization last accepted the Let''s Encrypt terms, needed to turn it on; the audit log says who.';
