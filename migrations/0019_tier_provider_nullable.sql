ALTER TABLE "tier" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tier" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tier" ADD CONSTRAINT "tier_provider_bound_check" CHECK (provider_product_id IS NULL OR provider IS NOT NULL);--> statement-breakpoint
UPDATE "tier" SET "provider" = NULL WHERE "provider_product_id" IS NULL;--> statement-breakpoint
COMMENT ON COLUMN "tier"."provider" IS 'Payment provider the row bills through: `stripe` (CHECK `tier_provider_check`), or NULL when `provider_product_id` is NULL, as on the `SX` row.';
