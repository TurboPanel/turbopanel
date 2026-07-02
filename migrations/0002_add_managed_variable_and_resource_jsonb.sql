CREATE TABLE "managed" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "managed_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "variable" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"environment_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	CONSTRAINT "variable_environment_id_key_unique" UNIQUE("environment_id","key"),
	CONSTRAINT "variable_key_format_check" CHECK ((char_length(key) >= 1) AND (char_length(key) <= 255) AND (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text))
);
--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_managed_project_id" ON "managed" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_environment_id" ON "variable" USING btree ("environment_id" uuid_ops);