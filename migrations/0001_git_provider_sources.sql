CREATE TABLE "installation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_installation_id" text NOT NULL,
	"account_login" varchar(255),
	"account_type" text,
	"suspended_at" timestamp(3) with time zone,
	"oauth_envelope" jsonb,
	CONSTRAINT "uniq_installation_organization_provider_external" UNIQUE("organization_id","provider","external_installation_id"),
	CONSTRAINT "installation_provider_check" CHECK (provider IN ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"installation_id" uuid,
	"service_id" uuid,
	"environment_id" uuid,
	"credential_id" uuid,
	"provider" text NOT NULL,
	"repository_url" text NOT NULL,
	"repository_external_id" text,
	"default_branch" varchar(255),
	"subdirectory" text,
	"auto_deploy" text DEFAULT 'disabled' NOT NULL,
	CONSTRAINT "source_provider_check" CHECK (provider IN ('github', 'gitlab', 'git')),
	CONSTRAINT "source_auto_deploy_check" CHECK (auto_deploy IN ('immediate', 'checks_passed', 'disabled')),
	CONSTRAINT "source_at_most_one_parent_check" CHECK (((service_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int) <= 1)
);
--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"external_delivery_id" text NOT NULL,
	"event" text,
	CONSTRAINT "uniq_delivery_provider_external" UNIQUE("provider","external_delivery_id"),
	CONSTRAINT "delivery_provider_check" CHECK (provider IN ('github', 'gitlab'))
);
--> statement-breakpoint
ALTER TABLE "credential" DROP CONSTRAINT "credential_provider_check";--> statement-breakpoint
ALTER TABLE "installation" ADD CONSTRAINT "installation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_installation_id_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_installation_organization_id" ON "installation" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_source_organization_id" ON "source" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_source_installation_id" ON "source" USING btree ("installation_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_source_service_id" ON "source" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_source_environment_id" ON "source" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_source_credential_id" ON "source" USING btree ("credential_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_delivery_created_at" ON "delivery" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_provider_check" CHECK (provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key'));