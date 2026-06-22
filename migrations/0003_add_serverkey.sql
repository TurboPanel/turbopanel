CREATE TABLE "serverkey" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"algorithm" text DEFAULT 'Ed25519' NOT NULL,
	"public_key" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"last_used_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone,
	"revoked_at" timestamp(3) with time zone,
	CONSTRAINT "serverkey_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
ALTER TABLE "serverkey" ADD CONSTRAINT "serverkey_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_serverkey_server_id" ON "serverkey" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_serverkey_fingerprint" ON "serverkey" USING btree ("fingerprint" text_ops);--> statement-breakpoint
CREATE INDEX "idx_serverkey_active" ON "serverkey" USING btree ("server_id","revoked_at") WHERE revoked_at IS NULL;
