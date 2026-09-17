ALTER TABLE "organization" DROP CONSTRAINT "organization_slug_unique";--> statement-breakpoint
ALTER TABLE "backup" DROP CONSTRAINT "backup_id_format_check";--> statement-breakpoint
ALTER TABLE "payer" DROP CONSTRAINT "payer_provider_check";--> statement-breakpoint
ALTER TABLE "tier" DROP CONSTRAINT "tier_provider_check";--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
-- Hand-corrected (drizzle-kit emitted `ALTER COLUMN "id" SET DATA TYPE uuid` with no
-- USING, which Postgres refuses for text -> uuid even on an empty table, and added
-- "backup_id" NOT NULL with no backfill). The daemon's own id moves from the primary
-- key to "backup_id"; "id" becomes a fresh uuidv7 like every other table. Order:
-- add the column nullable, copy, then tighten, then retype the key.
ALTER TABLE "backup" ADD COLUMN "backup_id" text;--> statement-breakpoint
UPDATE "backup" SET "backup_id" = "id";--> statement-breakpoint
ALTER TABLE "backup" ALTER COLUMN "backup_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "backup" ALTER COLUMN "id" SET DATA TYPE uuid USING uuidv7();--> statement-breakpoint
ALTER TABLE "backup" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "dispatch" ADD COLUMN "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-corrected: the raw provider value existing rows carry in "status" is the
-- backfill for "provider_status"; "status" itself is then narrowed to the checked
-- vocabulary (anything Stripe sent that the code does not know becomes 'unknown').
ALTER TABLE "subscription" ADD COLUMN "provider_status" text;--> statement-breakpoint
UPDATE "subscription" SET "provider_status" = "status";--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "provider_status" SET NOT NULL;--> statement-breakpoint
UPDATE "subscription" SET "status" = 'unknown' WHERE "status" NOT IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused');--> statement-breakpoint
ALTER TABLE "2fa" ADD COLUMN "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backup_managed_backup_id" ON "backup" USING btree ("managed_id","backup_id");--> statement-breakpoint
CREATE INDEX "idx_leaf_ca_id" ON "leaf" USING btree ("ca_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_managed_id" ON "leaf" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_server_id" ON "leaf" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ssh_user_id" ON "ssh" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_principal_id" ON "storage" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$');--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_status_check" CHECK (status IN ('queued', 'dispatching', 'sent', 'acked', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'));--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_actor_type_check" CHECK (actor_type IN ('user', 'system'));--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_status_check" CHECK (status IN ('pending', 'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown'));--> statement-breakpoint
ALTER TABLE "grant" ADD CONSTRAINT "grant_actor_type_check" CHECK (actor_type IN ('user', 'team', 'organization'));--> statement-breakpoint
ALTER TABLE "grant" ADD CONSTRAINT "grant_entity_type_check" CHECK (entity_type IN ('organization', 'workspace', 'environment', 'project', 'service', 'server', 'hosting', 'variable', 'managed', 'container', 'tls', 'team'));--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_status_check" CHECK (status IN ('pending', 'accepted', 'revoked'));--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_provider_check" CHECK (provider IN ('stripe'));--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_status_check" CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'unknown'));--> statement-breakpoint
ALTER TABLE "tier" ADD CONSTRAINT "tier_provider_check" CHECK (provider IN ('stripe'));--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_status_check" CHECK (status IN ('ready', 'pending', 'expired', 'failed', 'revoked', 'managed'));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_check" CHECK (role IN ('user', 'admin', 'superadmin'));