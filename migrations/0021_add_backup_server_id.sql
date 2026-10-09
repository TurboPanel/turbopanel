ALTER TABLE "backup" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_backup_server_id" ON "backup" USING btree ("server_id");--> statement-breakpoint
COMMENT ON COLUMN "backup"."server_id" IS 'Host that holds the on-disk artifact (the primary when the backup ran); null on older rows or after that server is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."path" IS 'Absolute artifact path on the filesystem of the host that made it, as reported by the daemon.';