CREATE TABLE "key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"algorithm" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"revoked_at" timestamp(3) with time zone,
	"last_used_at" timestamp(3) with time zone,
	CONSTRAINT "key_algorithm_check" CHECK (algorithm = 'Ed25519')
);
--> statement-breakpoint
ALTER TABLE "key" ADD CONSTRAINT "key_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_key_server" ON "key" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_key_fingerprint" ON "key" USING btree ("fingerprint");