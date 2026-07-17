-- Soft-revoke orphan colocated licenses (display_name = 'this server' and not
-- referenced by any server.license_id) so the unique index below can build.
-- Keeps the license actually bound to a server; disk-recovery then rotates via
-- ensureColocatedLicenseCredentialsOnDisk when plaintext creds are missing.
UPDATE "license"
SET "revoked_at" = now(), "updated_at" = now()
WHERE "display_name" = 'this server'
  AND "revoked_at" IS NULL
  AND "id" NOT IN (
    SELECT "license_id" FROM "server" WHERE "license_id" IS NOT NULL
  );--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_license_colocated_active" ON "license" USING btree ("organization_id") WHERE "license"."display_name" = 'this server' AND "license"."revoked_at" IS NULL;
