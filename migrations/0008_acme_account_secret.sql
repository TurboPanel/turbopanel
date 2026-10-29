ALTER TABLE "secret" DROP CONSTRAINT "secret_provider_check";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_secret_acme_account" ON "secret" USING btree ("organization_id","name") WHERE "secret"."provider" = 'acme_account';--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_provider_check" CHECK (provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key', 'carrier_badge', 'tunnel_run', 'acme_account'));