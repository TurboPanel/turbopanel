CREATE TABLE "command" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"server_id" uuid NOT NULL,
	"actor_entity_type" text NOT NULL,
	"actor_entity_id" uuid NOT NULL,
	"metadata" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_command_server_id_created_at" ON "command" USING btree ("server_id",("metadata"->>'createdAt') desc);--> statement-breakpoint
CREATE INDEX "idx_command_status" ON "command" USING btree (("metadata"->>'status'));