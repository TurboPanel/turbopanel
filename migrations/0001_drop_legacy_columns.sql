-- breaking-ok: nothing reads or writes server.plaintext_secrets_at since the sealed-secrets removal; owner approved the drop 2026-11-18
ALTER TABLE "server" DROP COLUMN IF EXISTS "plaintext_secrets_at";--> statement-breakpoint
DELETE FROM "setting" WHERE "key" = 'TURBOPANEL_PUBLIC_URLS';
