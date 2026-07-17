-- Deduplicate existing verification rows (keep newest per identifier) before
-- enforcing uniqueness required by OTP/token upserts.
DELETE FROM "verification" AS v
USING "verification" AS newer
WHERE v."identifier" = newer."identifier"
  AND (
    v."created_at" < newer."created_at"
    OR (v."created_at" = newer."created_at" AND v."id" < newer."id")
  );--> statement-breakpoint
DROP INDEX "idx_verification_identifier";--> statement-breakpoint
ALTER TABLE "verification" ADD CONSTRAINT "verification_identifier_unique" UNIQUE("identifier");
