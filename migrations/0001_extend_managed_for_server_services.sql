ALTER TABLE "managed" DROP CONSTRAINT "managed_project_id_unique";--> statement-breakpoint
ALTER TABLE "managed" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "managed" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "managed" ADD COLUMN "display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_server_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_managed_server_id" ON "managed" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "managed_project_id_unique" ON "managed" USING btree ("project_id") WHERE "managed"."project_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_parent_check" CHECK (("managed"."project_id" IS NOT NULL) OR ("managed"."server_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_display_name_format_check" CHECK (("managed"."display_name" IS NULL) OR (((char_length(("managed"."display_name")::text) >= 1) AND (char_length(("managed"."display_name")::text) <= 255)) AND (("managed"."display_name")::text ~ '^[A-Za-z0-9 ._-]+$'::text)));