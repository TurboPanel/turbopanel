ALTER TABLE "managed" DROP CONSTRAINT "managed_parent_check";--> statement-breakpoint
ALTER TABLE "managed" DROP CONSTRAINT "managed_server_fk";
--> statement-breakpoint
DROP INDEX "idx_managed_server_id";--> statement-breakpoint
ALTER TABLE "managed" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_managed_environment_id" ON "managed" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "managed_environment_id_unique" ON "managed" USING btree ("environment_id") WHERE "managed"."environment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "managed" DROP COLUMN "server_id";--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_parent_check" CHECK (("managed"."project_id" IS NOT NULL) OR ("managed"."environment_id" IS NOT NULL));
