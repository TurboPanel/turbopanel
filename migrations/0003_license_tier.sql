-- A registration key can carry the tier a manager chose in Add Server, so the
-- server that enrolls with it comes up on that tier. Additive: a nullable
-- column the previous release never reads or writes.
ALTER TABLE "license" ADD COLUMN "tier_id" uuid;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_tier_id_tier_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."tier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_license_tier_id" ON "license" USING btree ("tier_id");--> statement-breakpoint
COMMENT ON TABLE "license" IS 'Organization-scoped server registration key: one row per minted key, latched to one server on first enroll, soft-deleted via `revoked_at`; may name a tier.';--> statement-breakpoint
COMMENT ON COLUMN "license"."tier_id" IS 'Tier a manager chose in Add Server (hosted); holds a seat there until a server enrolls with this key and takes it. NULL when no tier was chosen.';--> statement-breakpoint
COMMENT ON COLUMN "server"."assigned_tier_id" IS 'Tier a manager assigned this server (Add Server choice, license-tier route or a named size change); self-hosted fills the top tier. NULL until set.';--> statement-breakpoint
COMMENT ON COLUMN "server"."preferred_tier_id" IS 'Written in step with `assigned_tier_id`, for the console''s picked label; set alone when the Add Server tier had no free seat at enroll.';
