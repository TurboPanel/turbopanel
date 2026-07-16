CREATE TABLE "assignment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "assignment_principal_service_unique" UNIQUE("principal_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"username" varchar(255) NOT NULL,
	"password" text,
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "principal_kind_check" CHECK (kind IN ('system', 'database')),
	CONSTRAINT "principal_provider_check" CHECK (provider IN ('pam', 'postgres', 'mysql', 'redis')),
	CONSTRAINT "principal_username_format_check" CHECK ((char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text))
);
--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assignment_principal_id" ON "assignment" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_assignment_service_id" ON "assignment" USING btree ("service_id" uuid_ops);