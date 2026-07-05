CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp(3) with time zone,
	"refresh_token_expires_at" timestamp(3) with time zone,
	"scope" text,
	"password" text
);
--> statement-breakpoint
CREATE TABLE "command" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"server_id" uuid NOT NULL,
	"actor_entity_type" text NOT NULL,
	"actor_entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "environment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"project_id" uuid NOT NULL,
	"display_name" varchar(255),
	"description" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "environment_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "grant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"allow" boolean DEFAULT true NOT NULL,
	CONSTRAINT "grant_unique" UNIQUE("entity_type","entity_id","actor_type","actor_id","permission")
);
--> statement-breakpoint
CREATE TABLE "hosting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"service_id" uuid NOT NULL,
	"display_name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "hosting_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"grants" jsonb
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" varchar(255),
	"token" text NOT NULL,
	"revoked_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "managed" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone,
	"project_id" uuid NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "managed_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "member_org_user_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "network" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(255),
	"slug" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organization_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now(),
	"user_id" uuid NOT NULL,
	"aaguid" text,
	"name" varchar(255),
	"public_key" text NOT NULL,
	"credential_id" varchar(255) NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" varchar(32) NOT NULL,
	"is_backed_up" boolean NOT NULL,
	"transports" text
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" varchar(255),
	"description" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "project_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"organization_id" uuid,
	"license_id" uuid,
	"display_name" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	"daemon" jsonb
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"environment_id" uuid NOT NULL,
	"display_name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "service_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"token" varchar(255) NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "setting_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" varchar(255),
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "team_display_name_format_check" CHECK ((display_name IS NULL) OR ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)))
);
--> statement-breakpoint
CREATE TABLE "teammate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "teammate_team_user_unique" UNIQUE("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "2fa" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" varchar(255) NOT NULL,
	"is_verified" boolean DEFAULT true,
	"backup_codes" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(255),
	"username" varchar(255),
	"display_username" varchar(255),
	"email" varchar(255) NOT NULL,
	"is_email_verified" boolean DEFAULT false NOT NULL,
	"is_2fa_enabled" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username"),
	CONSTRAINT "user_display_name_format_check" CHECK ((display_name IS NULL) OR ((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255))),
	CONSTRAINT "user_username_format_check" CHECK ((username IS NULL) OR ((char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255))),
	CONSTRAINT "user_display_username_format_check" CHECK ((display_username IS NULL) OR ((char_length((display_username)::text) >= 1) AND (char_length((display_username)::text) <= 255)))
);
--> statement-breakpoint
CREATE TABLE "variable" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"workspace_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"hosting_id" uuid,
	"server_id" uuid,
	"key" varchar(255) NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"description" varchar(255),
	CONSTRAINT "variable_exactly_one_parent_check" CHECK (((organization_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (hosting_id IS NOT NULL)::int +
        (server_id IS NOT NULL)::int) = 1),
	CONSTRAINT "variable_key_format_check" CHECK ((char_length(key) >= 1) AND (char_length(key) <= 255) AND (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "workspace_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "workspace_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_license_id_license_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."license"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "2fa" ADD CONSTRAINT "2fa_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_command_server_id_created_at" ON "command" USING btree ("server_id",("metadata"->>'createdAt') desc);--> statement-breakpoint
CREATE INDEX "idx_command_status" ON "command" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_environment_project_id" ON "environment" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_grant_entity" ON "grant" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_grant_actor" ON "grant" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_hosting_service_id" ON "hosting" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_email" ON "invitation" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_license_organization_id" ON "license" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_managed_project_id" ON "managed" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_member_organization_id" ON "member" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_member_user_id" ON "member" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_server_id" ON "network" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_passkey_credential_id" ON "passkey" USING btree ("credential_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_passkey_user_id" ON "passkey" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_workspace_id" ON "project" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_service_environment_id" ON "service" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_session_user_id" ON "session" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_team_organization_id" ON "team" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_teammate_team_id" ON "teammate" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_teammate_user_id" ON "teammate" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_2fa_secret" ON "2fa" USING btree ("secret" text_ops);--> statement-breakpoint
CREATE INDEX "idx_2fa_user_id" ON "2fa" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_organization_id" ON "variable" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_workspace_id" ON "variable" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_project_id" ON "variable" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_environment_id" ON "variable" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_service_id" ON "variable" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_hosting_id" ON "variable" USING btree ("hosting_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_server_id" ON "variable" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_org" ON "variable" USING btree ("key","organization_id") WHERE "variable"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_workspace" ON "variable" USING btree ("key","workspace_id") WHERE "variable"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_project" ON "variable" USING btree ("key","project_id") WHERE "variable"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_environment" ON "variable" USING btree ("key","environment_id") WHERE "variable"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_service" ON "variable" USING btree ("key","service_id") WHERE "variable"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_hosting" ON "variable" USING btree ("key","hosting_id") WHERE "variable"."hosting_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_server" ON "variable" USING btree ("key","server_id") WHERE "variable"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_verification_identifier" ON "verification" USING btree ("identifier" text_ops);--> statement-breakpoint
CREATE INDEX "idx_workspace_organization_id" ON "workspace" USING btree ("organization_id" uuid_ops);