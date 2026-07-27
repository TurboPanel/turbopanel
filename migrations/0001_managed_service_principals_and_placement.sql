ALTER TABLE "principal" DROP CONSTRAINT "principal_provider_check";--> statement-breakpoint
ALTER TABLE "peer" ALTER COLUMN "public_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "managed" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "managed_id" uuid;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_managed_server_id" ON "managed" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_managed_id" ON "principal" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_status_check" CHECK (status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed'));--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_provider_check" CHECK (provider IN ('pam', 'postgres', 'mysql', 'redis', 'clickhouse'));