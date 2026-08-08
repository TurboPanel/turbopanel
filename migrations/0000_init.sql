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
CREATE TABLE "assignment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "assignment_principal_service_unique" UNIQUE("principal_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "command" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"server_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "container" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"service_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"container_id" text,
	"container_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"role" text DEFAULT 'service' NOT NULL,
	"compose_service_name" text NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "container_ordinal_positive_check" CHECK (ordinal >= 1),
	CONSTRAINT "container_role_check" CHECK (role IN ('service', 'ingress', 'system'))
);
--> statement-breakpoint
CREATE TABLE "datacenter" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "datacenter_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "environment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"project_id" uuid NOT NULL,
	"server_id" uuid,
	"name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "environment_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
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
	"metadata" jsonb,
	"options" jsonb,
	"service_id" uuid NOT NULL,
	"tls_id" uuid,
	"ip_id" uuid,
	"name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "hosting_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"email" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"grants" jsonb
);
--> statement-breakpoint
CREATE TABLE "ip" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"network_id" uuid,
	"server_id" uuid,
	"vpn_id" uuid,
	"address" "inet" NOT NULL,
	"allocation" text NOT NULL,
	"scope" text NOT NULL,
	"name" varchar(255),
	CONSTRAINT "ip_allocation_check" CHECK (allocation IN ('dedicated', 'shared')),
	CONSTRAINT "ip_scope_check" CHECK (scope IN ('public', 'datacenter', 'loopback', 'vpn')),
	CONSTRAINT "ip_vpn_scope_check" CHECK (("ip"."scope" = 'vpn' AND "ip"."vpn_id" IS NOT NULL) OR ("ip"."scope" <> 'vpn' AND "ip"."vpn_id" IS NULL)),
	CONSTRAINT "ip_datacenter_free_pool_check" CHECK (("ip"."datacenter_id" IS NULL) OR ("ip"."server_id" IS NULL AND "ip"."vpn_id" IS NULL AND "ip"."network_id" IS NULL)),
	CONSTRAINT "ip_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"name" varchar(255),
	"token" text NOT NULL,
	"revoked_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "managed" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"environment_id" uuid NOT NULL,
	"server_id" uuid,
	"name" varchar(255),
	"engine" text,
	"status" text,
	CONSTRAINT "managed_name_format_check" CHECK (("managed"."name" IS NULL) OR (((char_length(("managed"."name")::text) >= 1) AND (char_length(("managed"."name")::text) <= 255)) AND (("managed"."name")::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "managed_status_check" CHECK (status IS NULL OR status IN ('provisioning','applying','ready','stopped','failed'))
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
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"server_id" uuid,
	"kind" text NOT NULL,
	"cidr" "cidr",
	"name" varchar(255),
	CONSTRAINT "network_kind_check" CHECK (kind IN ('datacenter', 'server', 'docker')),
	CONSTRAINT "network_single_scope_check" CHECK ((
        ("network"."kind" = 'datacenter' AND "network"."datacenter_id" IS NOT NULL AND "network"."server_id" IS NULL) OR
        ("network"."kind" = 'server' AND "network"."server_id" IS NOT NULL AND "network"."datacenter_id" IS NULL) OR
        ("network"."kind" = 'docker' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL)
      )),
	CONSTRAINT "network_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"name" varchar(255),
	"slug" varchar(255),
	CONSTRAINT "organization_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organization_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
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
CREATE TABLE "peer" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"vpn_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"endpoint_ip_id" uuid,
	"tunnel_ip_id" uuid,
	"role" text DEFAULT 'member' NOT NULL,
	"public_key" text,
	"listen_port" integer,
	"endpoint" varchar(255),
	"preshared_key" text,
	CONSTRAINT "peer_vpn_server_unique" UNIQUE("vpn_id","server_id"),
	CONSTRAINT "peer_vpn_public_key_unique" UNIQUE("vpn_id","public_key"),
	CONSTRAINT "peer_role_check" CHECK (role IN ('gateway', 'member'))
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"username" varchar(255) NOT NULL,
	"password" text,
	"project_id" uuid,
	"managed_id" uuid,
	CONSTRAINT "principal_kind_check" CHECK (kind IN ('system', 'database')),
	CONSTRAINT "principal_provider_check" CHECK (provider IN ('server', 'postgres', 'mysql', 'redis', 'clickhouse')),
	CONSTRAINT "principal_username_format_check" CHECK ((char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255),
	"description" varchar(255),
	CONSTRAINT "project_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid,
	"datacenter_id" uuid,
	"name" varchar(255),
	"hostname" varchar(255),
	"machine_key" text,
	"connected" boolean DEFAULT false NOT NULL,
	"status_changed_at" timestamp(3) with time zone,
	"daemon" jsonb
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"environment_id" uuid NOT NULL,
	"name" varchar(255),
	"description" varchar(255),
	"compose_service_name" varchar(255) NOT NULL,
	CONSTRAINT "service_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
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
CREATE TABLE "storage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"kind" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"source_path" text,
	"destination_path" text,
	"principal_id" uuid,
	"content_envelope" text,
	CONSTRAINT "storage_kind_check" CHECK (kind IN ('docker_volume', 'bind_mount', 'file', 'directory')),
	CONSTRAINT "storage_exactly_one_parent_check" CHECK (((project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	CONSTRAINT "team_name_format_check" CHECK ((name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)))
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
CREATE TABLE "tls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	"source" text NOT NULL,
	"certificate_pem" text,
	"private_key_pem" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"not_after" timestamp(3) with time zone,
	"fingerprint_sha256" text,
	CONSTRAINT "tls_source_check" CHECK (source IN ('upload', 'lets_encrypt', 'self_signed')),
	CONSTRAINT "tls_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
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
	"metadata" jsonb,
	"options" jsonb,
	"name" varchar(255),
	"email" varchar(255) NOT NULL,
	"is_email_verified" boolean DEFAULT false NOT NULL,
	"is_2fa_enabled" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_name_format_check" CHECK ((name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)))
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
	"is_literal" boolean DEFAULT false NOT NULL,
	"for_build" boolean DEFAULT false NOT NULL,
	"for_runtime" boolean DEFAULT true NOT NULL,
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
	"value" text NOT NULL,
	CONSTRAINT "verification_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "vpn" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"cidr" "cidr" NOT NULL,
	"name" varchar(255),
	CONSTRAINT "vpn_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255),
	"description" varchar(255),
	"kind" varchar(32) DEFAULT 'user' NOT NULL,
	CONSTRAINT "workspace_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "workspace_kind_check" CHECK (kind IN ('user', 'system'))
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_tls_id_tls_id_fk" FOREIGN KEY ("tls_id") REFERENCES "public"."tls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_ip_id_ip_id_fk" FOREIGN KEY ("ip_id") REFERENCES "public"."ip"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_vpn_id_vpn_id_fk" FOREIGN KEY ("vpn_id") REFERENCES "public"."vpn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer" ADD CONSTRAINT "peer_vpn_id_vpn_id_fk" FOREIGN KEY ("vpn_id") REFERENCES "public"."vpn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer" ADD CONSTRAINT "peer_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer" ADD CONSTRAINT "peer_endpoint_ip_id_ip_id_fk" FOREIGN KEY ("endpoint_ip_id") REFERENCES "public"."ip"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer" ADD CONSTRAINT "peer_tunnel_ip_id_ip_id_fk" FOREIGN KEY ("tunnel_ip_id") REFERENCES "public"."ip"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "2fa" ADD CONSTRAINT "2fa_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vpn" ADD CONSTRAINT "vpn_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_assignment_principal_id" ON "assignment" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_assignment_service_id" ON "assignment" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_command_server_id_created_at" ON "command" USING btree ("server_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_command_status" ON "command" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_container_service_id" ON "container" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_container_server_id" ON "container" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_container_status" ON "container" USING btree ("status" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_server_container_id" ON "container" USING btree ("server_id","container_id") WHERE container_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_service_role_ordinal" ON "container" USING btree ("service_id","role","ordinal");--> statement-breakpoint
CREATE INDEX "idx_datacenter_organization_id" ON "datacenter" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_project_id" ON "environment" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_server_id" ON "environment" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_grant_entity" ON "grant" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_grant_actor" ON "grant" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_hosting_service_id" ON "hosting" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_tls_id" ON "hosting" USING btree ("tls_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_ip_id" ON "hosting" USING btree ("ip_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_email" ON "invitation" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_user_id" ON "invitation" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_team_id" ON "invitation" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_organization_id" ON "ip" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_datacenter_id" ON "ip" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_network_id" ON "ip" USING btree ("network_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_server_id" ON "ip" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_vpn_id" ON "ip" USING btree ("vpn_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ip_org_address" ON "ip" USING btree ("organization_id","address") WHERE "ip"."vpn_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ip_vpn_address" ON "ip" USING btree ("vpn_id","address") WHERE "ip"."vpn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_license_organization_id" ON "license" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_license_server_id" ON "license" USING btree ("server_id") WHERE "license"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_managed_environment_id" ON "managed" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_managed_server_id" ON "managed" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_managed_engine" ON "managed" USING btree ("engine" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "managed_environment_id_unique" ON "managed" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_member_organization_id" ON "member" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_member_user_id" ON "member" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_server_id" ON "network" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_organization_id" ON "network" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_datacenter_id" ON "network" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_passkey_credential_id" ON "passkey" USING btree ("credential_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_passkey_user_id" ON "passkey" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_peer_vpn_id" ON "peer" USING btree ("vpn_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_peer_server_id" ON "peer" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_peer_endpoint_ip_id" ON "peer" USING btree ("endpoint_ip_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_peer_tunnel_ip_id" ON "peer" USING btree ("tunnel_ip_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_peer_vpn_tunnel_ip" ON "peer" USING btree ("vpn_id","tunnel_ip_id") WHERE "peer"."tunnel_ip_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_principal_project_id" ON "principal" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_managed_id" ON "principal" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_workspace_id" ON "project" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_workspace_system_component" ON "project" USING btree ("workspace_id",(metadata->>'component')) WHERE (metadata->>'component') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_server_organization_id" ON "server" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_datacenter_id" ON "server" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_machine_key" ON "server" USING btree ("machine_key" text_ops);--> statement-breakpoint
CREATE INDEX "idx_server_hostname" ON "server" USING btree ("hostname" text_ops);--> statement-breakpoint
CREATE INDEX "idx_server_connected" ON "server" USING btree ("id") WHERE "server"."connected";--> statement-breakpoint
CREATE INDEX "idx_service_environment_id" ON "service" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_service_environment_compose_name" ON "service" USING btree ("environment_id","compose_service_name");--> statement-breakpoint
CREATE INDEX "idx_session_user_id" ON "session" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_organization_id" ON "storage" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_project_id" ON "storage" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_environment_id" ON "storage" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_service_id" ON "storage" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_server_id" ON "storage" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_storage_environment_compose_volume_key" ON "storage" USING btree ("environment_id" uuid_ops,("metadata" ->> 'composeVolumeKey')) WHERE kind = 'docker_volume'
          AND environment_id IS NOT NULL
          AND COALESCE(metadata->>'composeVolumeKey', '') <> '';--> statement-breakpoint
CREATE INDEX "idx_team_organization_id" ON "team" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_teammate_team_id" ON "teammate" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_teammate_user_id" ON "teammate" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tls_organization_id" ON "tls" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tls_not_after" ON "tls" USING btree ("not_after" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tls_organization_fingerprint_sha256" ON "tls" USING btree ("organization_id","fingerprint_sha256") WHERE "tls"."fingerprint_sha256" IS NOT NULL;--> statement-breakpoint
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
CREATE INDEX "idx_vpn_organization_id" ON "vpn" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vpn_organization_id_cidr" ON "vpn" USING btree ("organization_id","cidr");--> statement-breakpoint
CREATE INDEX "idx_workspace_organization_id" ON "workspace" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workspace_organization_system" ON "workspace" USING btree ("organization_id") WHERE kind = 'system';