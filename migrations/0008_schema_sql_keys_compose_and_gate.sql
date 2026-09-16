DROP INDEX "uniq_storage_environment_compose_volume_key";--> statement-breakpoint
ALTER TABLE "command" ADD COLUMN "managed_destroy_gate_id" text;--> statement-breakpoint
ALTER TABLE "hosting" ADD COLUMN "protocol" text;--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "compose_key" text;--> statement-breakpoint
ALTER TABLE "storage" ADD COLUMN "compose_volume_key" text;--> statement-breakpoint
CREATE INDEX "idx_command_managed_destroy_gate_id" ON "command" USING btree ("managed_destroy_gate_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_network_environment_compose_key" ON "network" USING btree ("environment_id","compose_key") WHERE "network"."kind" = 'compose';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_storage_environment_compose_volume_key" ON "storage" USING btree ("environment_id","compose_volume_key") WHERE kind = 'volume'
          AND environment_id IS NOT NULL
          AND compose_volume_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_protocol_check" CHECK (protocol IS NULL OR protocol IN ('http', 'tcp', 'udp'));