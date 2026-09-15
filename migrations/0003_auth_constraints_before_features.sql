DROP INDEX "idx_passkey_credential_id";--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "credential_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "passkey" ALTER COLUMN "counter" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "2fa" ALTER COLUMN "secret" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "2fa" ALTER COLUMN "is_verified" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "2fa" ALTER COLUMN "is_verified" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "uniq_account_provider_user" UNIQUE("provider_id","provider_user_id");--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "uniq_passkey_credential_id" UNIQUE("credential_id");--> statement-breakpoint
ALTER TABLE "2fa" ADD CONSTRAINT "uniq_2fa_user_id" UNIQUE("user_id");