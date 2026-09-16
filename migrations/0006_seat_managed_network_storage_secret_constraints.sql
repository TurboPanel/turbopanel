ALTER TABLE "secret" DROP CONSTRAINT "secret_principal_id_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "storage" DROP CONSTRAINT "storage_principal_id_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "managed" ALTER COLUMN "engine" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "seat" ALTER COLUMN "provider_price_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;