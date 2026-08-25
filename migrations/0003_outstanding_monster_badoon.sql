CREATE TABLE "principal_ssh_key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_type" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"comment" text,
	"user_id" uuid,
	"bits" integer,
	CONSTRAINT "principal_ssh_key_fingerprint_unique" UNIQUE("principal_id","fingerprint"),
	CONSTRAINT "principal_ssh_key_type_check" CHECK ("principal_ssh_key"."key_type" IN ('ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa')),
	CONSTRAINT "principal_ssh_key_fingerprint_check" CHECK ("principal_ssh_key"."fingerprint" ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
	CONSTRAINT "principal_ssh_key_public_key_check" CHECK ("principal_ssh_key"."public_key" ~ '^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$'),
	CONSTRAINT "principal_ssh_key_name_check" CHECK (char_length("principal_ssh_key"."name") >= 1)
);
--> statement-breakpoint
ALTER TABLE "principal_ssh_key" ADD CONSTRAINT "principal_ssh_key_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_ssh_key" ADD CONSTRAINT "principal_ssh_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_principal_ssh_key_principal_id" ON "principal_ssh_key" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_ssh_key_fingerprint" ON "principal_ssh_key" USING btree ("fingerprint" text_ops);