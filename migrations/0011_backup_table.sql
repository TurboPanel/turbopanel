CREATE TABLE "backup" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"managed_id" uuid NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"database" text,
	"path" text NOT NULL,
	CONSTRAINT "backup_id_format_check" CHECK (id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "backup_checksum_format_check" CHECK (checksum ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "backup_size_bytes_check" CHECK (size_bytes >= 0)
);
--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_backup_managed_id_created_at" ON "backup" USING btree ("managed_id","created_at" DESC NULLS LAST);