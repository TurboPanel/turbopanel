CREATE TABLE "daemonsession" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"server_key_id" uuid NOT NULL,
	"last_used_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"revoked_at" timestamp(3) with time zone
);
--> statement-breakpoint
ALTER TABLE "daemonsession" ADD CONSTRAINT "daemonsession_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemonsession" ADD CONSTRAINT "daemonsession_server_key_id_serverkey_id_fk" FOREIGN KEY ("server_key_id") REFERENCES "public"."serverkey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_daemonsession_server_id" ON "daemonsession" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_daemonsession_server_key_id" ON "daemonsession" USING btree ("server_key_id" uuid_ops);