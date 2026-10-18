CREATE SEQUENCE "public"."principal_id_seq" INCREMENT BY 1 MINVALUE 15001 MAXVALUE 60000 START WITH 30001 CACHE 1;--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"password" text,
	CONSTRAINT "uniq_account_provider_user" UNIQUE("provider_id","provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "allowance" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "allowance_quantity_check" CHECK (quantity >= 1)
);
--> statement-breakpoint
CREATE TABLE "archive" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"copy_id" uuid NOT NULL,
	"retention_id" uuid,
	"backup_id" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "archive_backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "archive_checksum_format_check" CHECK (checksum ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "archive_size_bytes_check" CHECK (size_bytes >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"context" jsonb
);
--> statement-breakpoint
CREATE TABLE "backup" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"managed_id" uuid NOT NULL,
	"backup_id" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"database" text,
	"database_id" uuid,
	"path" text NOT NULL,
	"retention_id" uuid,
	"server_id" uuid,
	CONSTRAINT "backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "backup_checksum_format_check" CHECK (checksum ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "backup_size_bytes_check" CHECK (size_bytes >= 0)
);
--> statement-breakpoint
CREATE TABLE "binding" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"login_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"key_prefix" varchar(64) DEFAULT 'DATABASE' NOT NULL,
	"is_emit_engine_defaults" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uniq_binding_service_prefix" UNIQUE("service_id","key_prefix"),
	CONSTRAINT "binding_key_prefix_format_check" CHECK ((char_length((key_prefix)::text) >= 1) AND (char_length((key_prefix)::text) <= 64) AND ((key_prefix)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "bulwark" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"mode" text DEFAULT 'observe' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"last_digest" text,
	"last_result" jsonb,
	"last_kind" text,
	"state" text DEFAULT 'idle' NOT NULL,
	"deadline_at" timestamp(3) with time zone,
	"last_applied_at" timestamp(3) with time zone,
	"confirmed_at" timestamp(3) with time zone,
	CONSTRAINT "bulwark_mode_check" CHECK (mode IN ('observe', 'managed', 'off')),
	CONSTRAINT "bulwark_state_check" CHECK (state IN ('idle', 'pending', 'confirmed', 'rolled_back')),
	CONSTRAINT "bulwark_generation_check" CHECK (generation >= 0),
	CONSTRAINT "bulwark_last_kind_check" CHECK (last_kind IS NULL OR last_kind IN ('preview', 'apply', 'remove')),
	CONSTRAINT "bulwark_digest_format_check" CHECK (last_digest IS NULL OR last_digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "changeover" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"organization_id" uuid NOT NULL,
	"from_ca_generation" integer DEFAULT 0 NOT NULL,
	"to_ca_generation" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp(3) with time zone,
	"results" jsonb DEFAULT '[]'::jsonb,
	CONSTRAINT "changeover_state_check" CHECK ("changeover"."state" IN ('in_progress','awaiting_retire','completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "address" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"datacenter_id" uuid,
	"hostname" varchar(253),
	"address_v4" "inet",
	"address_v6" "inet",
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "address_scope_check" CHECK (scope IN ('public', 'datacenter')),
	CONSTRAINT "address_datacenter_scope_check" CHECK (("address"."scope" = 'datacenter') = ("address"."datacenter_id" IS NOT NULL)),
	CONSTRAINT "address_v4_family_check" CHECK (family("address"."address_v4") = 4),
	CONSTRAINT "address_v6_family_check" CHECK (family("address"."address_v6") = 6)
);
--> statement-breakpoint
CREATE TABLE "command" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"server_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"context" jsonb,
	"result_summary" jsonb,
	"progress" jsonb,
	"error_code" text,
	"error_message" text,
	"queued_at" timestamp(3) with time zone,
	"dispatch_started_at" timestamp(3) with time zone,
	"sent_at" timestamp(3) with time zone,
	"acked_at" timestamp(3) with time zone,
	"started_at" timestamp(3) with time zone,
	"finished_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone,
	"managed_destroy_gate_id" text,
	"organization_id" uuid,
	"environment_id" uuid,
	"managed_id" uuid,
	CONSTRAINT "command_status_check" CHECK (status IN ('queued', 'dispatching', 'sent', 'acked', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
	CONSTRAINT "command_actor_type_check" CHECK (actor_type IN ('user', 'system'))
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
	CONSTRAINT "container_role_check" CHECK (role IN ('service', 'ingress', 'turbopanel')),
	CONSTRAINT "container_status_check" CHECK (status IN ('pending', 'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "datacenter" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" text,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "deployment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"environment_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"desired_generation" integer DEFAULT 0 NOT NULL,
	"applied_generation" integer,
	"desired_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_command_id" uuid,
	"finished_at" timestamp(3) with time zone,
	"duration_ms" integer,
	"outcome" text,
	CONSTRAINT "uniq_deployment_environment_server" UNIQUE("environment_id","server_id"),
	CONSTRAINT "deployment_status_check" CHECK ("deployment"."status" IN ('pending','applying','applied','failed','draining')),
	CONSTRAINT "deployment_generation_check" CHECK ("deployment"."desired_generation" >= 0 AND ("deployment"."applied_generation" IS NULL OR "deployment"."applied_generation" >= 0)),
	CONSTRAINT "deployment_outcome_check" CHECK ("deployment"."outcome" IS NULL OR "deployment"."outcome" IN ('applied','failed','timed_out'))
);
--> statement-breakpoint
CREATE TABLE "dispatch" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "edict" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"label" text NOT NULL,
	"scope" text NOT NULL,
	"action" text NOT NULL,
	"proto" text NOT NULL,
	"ports" text,
	"source_kind" text NOT NULL,
	"source_addresses" "inet"[] DEFAULT '{}'::inet[] NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "edict_scope_check" CHECK (scope IN ('host', 'published')),
	CONSTRAINT "edict_action_check" CHECK (action IN ('accept', 'drop', 'reject')),
	CONSTRAINT "edict_proto_check" CHECK (proto IN ('tcp', 'udp', 'any')),
	CONSTRAINT "edict_source_kind_check" CHECK (source_kind IN ('any', 'servers', 'datacenter', 'fabric', 'addresses')),
	CONSTRAINT "edict_label_format_check" CHECK (label ~ '^[A-Za-z0-9 ._:/-]{1,48}$'),
	CONSTRAINT "edict_ports_format_check" CHECK (ports IS NULL OR ports ~ '^[0-9]{1,5}(-[0-9]{1,5})?$'),
	CONSTRAINT "edict_ports_proto_check" CHECK (ports IS NULL OR proto <> 'any'),
	CONSTRAINT "edict_accept_ports_check" CHECK (action <> 'accept' OR ports IS NOT NULL),
	CONSTRAINT "edict_source_addresses_check" CHECK ((source_kind = 'addresses' AND cardinality(source_addresses) BETWEEN 1 AND 256) OR (source_kind <> 'addresses' AND cardinality(source_addresses) = 0))
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
	"generation" integer DEFAULT 0 NOT NULL,
	"name" text DEFAULT replace(uuidv7()::text, '-', '') NOT NULL,
	"description" text,
	CONSTRAINT "uniq_environment_project_name" UNIQUE("project_id","name"),
	CONSTRAINT "environment_name_check" CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND name NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging'))
);
--> statement-breakpoint
CREATE TABLE "fabric" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"cidr" "cidr" NOT NULL,
	"name" text,
	CONSTRAINT "fabric_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "folder" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"environment_id" uuid,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"service_id" uuid,
	"storage_id" uuid,
	"state" text NOT NULL,
	CONSTRAINT "folder_kind_check" CHECK (kind IN ('service', 'volume')),
	CONSTRAINT "folder_state_check" CHECK (state IN ('planned', 'present', 'removing', 'orphan', 'missing')),
	CONSTRAINT "folder_slug_check" CHECK (slug ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$' AND slug !~ '\.\.'),
	CONSTRAINT "folder_scope_check" CHECK (scope = 'common' OR (scope ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND scope NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging'))),
	CONSTRAINT "folder_common_scope_check" CHECK ((scope = 'common' AND environment_id IS NULL) OR (scope <> 'common' AND (environment_id IS NOT NULL OR state = 'orphan'))),
	CONSTRAINT "folder_asset_kind_check" CHECK ((kind = 'service' AND storage_id IS NULL) OR (kind = 'volume' AND service_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "forge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"base_url" text NOT NULL,
	"api_url" text,
	"external_app_id" text NOT NULL,
	"app_slug" varchar(255),
	"client_id" text,
	"redirect_uri" text,
	"webhook_origin" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"custom_git_user" varchar(64),
	"custom_git_port" integer,
	"synced_at" timestamp(3) with time zone,
	"envelopes" jsonb NOT NULL,
	"webhook_ref" varchar(64) NOT NULL,
	"webhook_token_hash" text,
	CONSTRAINT "uniq_forge_webhook_ref" UNIQUE("webhook_ref"),
	CONSTRAINT "uniq_forge_provider_base_external" UNIQUE("provider","base_url","external_app_id"),
	CONSTRAINT "uniq_forge_webhook_token_hash" UNIQUE("webhook_token_hash"),
	CONSTRAINT "forge_provider_check" CHECK (provider IN ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"forge_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_installation_id" text NOT NULL,
	"account_login" varchar(255),
	"account_type" text,
	"suspended_at" timestamp(3) with time zone,
	"oauth_envelope" jsonb,
	CONSTRAINT "uniq_connection_organization_forge_external" UNIQUE("organization_id","forge_id","external_installation_id"),
	CONSTRAINT "connection_provider_check" CHECK (provider IN ('github', 'gitlab'))
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "permission_unique" UNIQUE("entity_type","entity_id","actor_type","actor_id","permission"),
	CONSTRAINT "permission_actor_type_check" CHECK (actor_type IN ('user', 'team', 'organization')),
	CONSTRAINT "permission_entity_type_check" CHECK (entity_type IN ('organization', 'workspace', 'environment', 'project', 'service', 'server', 'hosting', 'variable', 'managed', 'container', 'tls', 'team'))
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
	"name" text,
	"description" text,
	"protocol" text,
	"pending_at" timestamp(3) with time zone,
	CONSTRAINT "hosting_protocol_check" CHECK (protocol IS NULL OR protocol IN ('http', 'tcp', 'udp'))
);
--> statement-breakpoint
CREATE TABLE "hostname" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"hosting_id" uuid NOT NULL,
	"routing_organization_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	CONSTRAINT "uniq_hostname_routing_organization_id_hostname" UNIQUE("routing_organization_id","hostname")
);
--> statement-breakpoint
CREATE TABLE "origin" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"host" text NOT NULL,
	"source" text NOT NULL,
	"uploaded_cert_id" uuid,
	"acme_last_attempt_at" timestamp(3) with time zone,
	"acme_last_error" text,
	"not_after" timestamp(3) with time zone,
	CONSTRAINT "origin_host_unique" UNIQUE("host"),
	CONSTRAINT "origin_source_check" CHECK (source IN ('platform-ca', 'uploaded', 'lets-encrypt')),
	CONSTRAINT "origin_uploaded_cert_check" CHECK ((source <> 'uploaded') OR (uploaded_cert_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "certificate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"label" text NOT NULL,
	"cert_pem" text NOT NULL,
	"key_pem" text NOT NULL,
	"dns_names" jsonb NOT NULL,
	"not_after" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"email" varchar(255) NOT NULL,
	"status" text NOT NULL,
	"grants" jsonb,
	"token_hash" text,
	CONSTRAINT "invitation_status_check" CHECK (status IN ('pending', 'accepted', 'revoked'))
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
	"address" "inet" NOT NULL,
	"allocation" text NOT NULL,
	"scope" text NOT NULL,
	"description" text,
	"repin_pending_fanout_at" timestamp(3) with time zone,
	CONSTRAINT "ip_allocation_check" CHECK (allocation IN ('dedicated', 'shared')),
	CONSTRAINT "ip_scope_check" CHECK (scope IN ('public', 'datacenter')),
	CONSTRAINT "ip_datacenter_scope_check" CHECK (("ip"."scope" <> 'datacenter') OR ("ip"."datacenter_id" IS NOT NULL)),
	CONSTRAINT "ip_datacenter_anchor_check" CHECK ((
        "ip"."datacenter_id" IS NULL OR
        ("ip"."server_id" IS NULL AND "ip"."network_id" IS NULL) OR
        "ip"."server_id" IS NOT NULL
      )),
	CONSTRAINT "ip_datacenter_member_network_check" CHECK ((
        "ip"."scope" <> 'datacenter' OR
        "ip"."server_id" IS NULL OR
        "ip"."network_id" IS NOT NULL
      ))
);
--> statement-breakpoint
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
CREATE TABLE "label" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	CONSTRAINT "uniq_label_server_key" UNIQUE("server_id","key"),
	CONSTRAINT "label_key_format_check" CHECK ((char_length(("label"."key")::text) >= 1) AND (char_length(("label"."key")::text) <= 255) AND (("label"."key")::text ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "leaf" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"managed_id" uuid,
	"replica_id" uuid,
	"ca_id" uuid NOT NULL,
	"ca_generation" integer NOT NULL,
	"not_after" timestamp(3) with time zone NOT NULL,
	"issued_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaf_kind_check" CHECK ("leaf"."kind" IN ('ingress','engine')),
	CONSTRAINT "leaf_kind_keys_check" CHECK ((
        ("leaf"."kind" = 'ingress' AND "leaf"."replica_id" IS NULL AND "leaf"."managed_id" IS NULL)
        OR
        ("leaf"."kind" = 'engine' AND "leaf"."replica_id" IS NOT NULL AND "leaf"."managed_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "lease" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"organization_id" uuid,
	"owner" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"cursor" jsonb,
	CONSTRAINT "uniq_lease_name_organization" UNIQUE NULLS NOT DISTINCT("name","organization_id")
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"name" text,
	"token" text NOT NULL,
	"revoked_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "login" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"managed_id" uuid NOT NULL,
	"principal_id" uuid,
	"role" text NOT NULL,
	"username" varchar(255) NOT NULL,
	"applied_username" varchar(255) NOT NULL,
	"name_scheme" text DEFAULT 'plain' NOT NULL,
	"password" text,
	"grant_mode" text DEFAULT 'preset' NOT NULL,
	"is_tool" boolean DEFAULT false NOT NULL,
	"allowed_sources" text[],
	"max_connections" integer,
	"access" text DEFAULT 'read-write' NOT NULL,
	"privileges" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "login_role_check" CHECK (role IN ('root', 'replication', 'user')),
	CONSTRAINT "login_name_scheme_check" CHECK (name_scheme IN ('plain', 'partial', 'random')),
	CONSTRAINT "login_grant_mode_check" CHECK (grant_mode IN ('preset', 'recipe', 'self')),
	CONSTRAINT "login_access_check" CHECK (access IN ('read-write', 'read-only')),
	CONSTRAINT "login_max_connections_check" CHECK (max_connections IS NULL OR max_connections >= 1),
	CONSTRAINT "login_applied_username_format_check" CHECK ((char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text))
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
	"name" text,
	"engine" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	CONSTRAINT "managed_name_format_check" CHECK (("managed"."name" IS NULL) OR (((char_length(("managed"."name")::text) >= 1) AND (char_length(("managed"."name")::text) <= 255)) AND (("managed"."name")::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "managed_engine_check" CHECK (engine IN ('postgres', 'mysql', 'mariadb', 'redis', 'clickhouse')),
	CONSTRAINT "managed_status_check" CHECK (status IN ('provisioning','applying','ready','stopped','failed'))
);
--> statement-breakpoint
CREATE TABLE "database" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"managed_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_role_owned" boolean DEFAULT false NOT NULL,
	"owner_login_id" uuid,
	CONSTRAINT "database_name_check" CHECK (char_length(name) >= 1),
	CONSTRAINT "database_owner_role_check" CHECK (owner_login_id IS NULL OR is_role_owned)
);
--> statement-breakpoint
CREATE TABLE "marker" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"tag_id" uuid NOT NULL,
	"server_id" uuid,
	"workspace_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"datacenter_id" uuid,
	"storage_id" uuid,
	CONSTRAINT "marker_exactly_one_parent_check" CHECK (((server_id IS NOT NULL)::int +
        (workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int +
        (datacenter_id IS NOT NULL)::int +
        (storage_id IS NOT NULL)::int) = 1)
);
--> statement-breakpoint
CREATE TABLE "monitor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"username" varchar(64) NOT NULL,
	"secret_envelope" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mount" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"storage_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"destination_path" text NOT NULL,
	"subpath" text,
	"is_read_only" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_mount_service_destination" UNIQUE("service_id","destination_path")
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
	"environment_id" uuid,
	"kind" text NOT NULL,
	"cidr" "cidr",
	"name" varchar(255),
	"compose_key" text,
	CONSTRAINT "network_kind_check" CHECK (kind IN ('datacenter', 'docker', 'compose', 'managed', 'reserved')),
	CONSTRAINT "network_single_scope_check" CHECK ((
        ("network"."kind" = 'datacenter' AND "network"."datacenter_id" IS NOT NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NOT NULL) OR
        ("network"."kind" = 'docker' AND "network"."datacenter_id" IS NULL AND "network"."environment_id" IS NULL) OR
        ("network"."kind" = 'compose' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL) OR
        ("network"."kind" = 'managed' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NULL) OR
        ("network"."kind" = 'reserved' AND "network"."datacenter_id" IS NULL AND "network"."server_id" IS NULL AND "network"."environment_id" IS NULL AND "network"."cidr" IS NOT NULL)
      )),
	CONSTRAINT "network_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"event" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"target_type" text,
	"target_id" uuid,
	"context" jsonb,
	"read_at" timestamp(3) with time zone,
	"dismissed_at" timestamp(3) with time zone,
	CONSTRAINT "notification_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked')),
	CONSTRAINT "notification_severity_check" CHECK (severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"scope" text NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"signing_secret" text,
	"verified_at" timestamp(3) with time zone,
	"disabled_at" timestamp(3) with time zone,
	"created_by_user_id" uuid,
	"digest_cadence" text,
	"quiet_start_minute" smallint,
	"quiet_end_minute" smallint,
	CONSTRAINT "channel_scope_check" CHECK (scope IN ('instance', 'organization', 'user')),
	CONSTRAINT "channel_kind_check" CHECK (kind IN ('email', 'webhook', 'slack', 'discord', 'telegram', 'push')),
	CONSTRAINT "channel_owner_check" CHECK ((scope = 'instance' AND organization_id IS NULL AND user_id IS NULL) OR (scope = 'organization' AND organization_id IS NOT NULL AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)),
	CONSTRAINT "channel_digest_cadence_check" CHECK (digest_cadence IS NULL OR digest_cadence IN ('hourly', 'daily')),
	CONSTRAINT "channel_quiet_hours_check" CHECK ((quiet_start_minute IS NULL AND quiet_end_minute IS NULL) OR (quiet_start_minute BETWEEN 0 AND 1439 AND quiet_end_minute BETWEEN 0 AND 1439 AND quiet_start_minute <> quiet_end_minute))
);
--> statement-breakpoint
CREATE TABLE "attempt" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"channel_id" uuid NOT NULL,
	"organization_id" uuid,
	"event" text NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp(3) with time zone,
	"sent_at" timestamp(3) with time zone,
	"last_error" text,
	CONSTRAINT "attempt_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked')),
	CONSTRAINT "attempt_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "attempt_status_check" CHECK (status IN ('pending', 'sent', 'failed', 'abandoned', 'held'))
);
--> statement-breakpoint
CREATE TABLE "rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"channel_id" uuid NOT NULL,
	"event" text NOT NULL,
	"min_severity" text DEFAULT 'info' NOT NULL,
	CONSTRAINT "rule_event_check" CHECK (event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked')),
	CONSTRAINT "rule_min_severity_check" CHECK (min_severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"options" jsonb,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"aaguid" text,
	"name" text,
	"public_key" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"device_type" varchar(32) NOT NULL,
	"is_backed_up" boolean NOT NULL,
	"transports" text,
	CONSTRAINT "uniq_passkey_credential_id" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "payer" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"provider" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"tax_id" text,
	CONSTRAINT "payer_subject_check" CHECK (("payer"."organization_id" IS NULL) <> ("payer"."user_id" IS NULL)),
	CONSTRAINT "payer_provider_check" CHECK (provider IN ('stripe'))
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"username" varchar(255) NOT NULL,
	"applied_username" varchar(255) NOT NULL,
	"password" text,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	CONSTRAINT "principal_username_format_check" CHECK ((char_length((username)::text) >= 1) AND (char_length((username)::text) <= 255) AND ((username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text)),
	CONSTRAINT "principal_applied_username_format_check" CHECK ((char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text))
);
--> statement-breakpoint
CREATE TABLE "placement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"state" text NOT NULL,
	"uid" integer,
	"gid" integer,
	"home" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "uniq_placement_principal_server" UNIQUE("principal_id","server_id"),
	CONSTRAINT "placement_state_check" CHECK (state IN ('pending', 'present', 'retiring', 'absent')),
	CONSTRAINT "placement_source_check" CHECK (source IN ('compose', 'manual', 'storage'))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"workspace_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid,
	"name" text,
	"description" text,
	"component" text,
	"slug" text DEFAULT uuidv7()::text NOT NULL,
	"default_server_id" uuid,
	CONSTRAINT "uniq_project_organization_slug" UNIQUE("organization_id","slug"),
	CONSTRAINT "project_slug_check" CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$')
);
--> statement-breakpoint
CREATE TABLE "recovery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"managed_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_primary_member_id" uuid NOT NULL,
	"target_member_id" uuid,
	"state" text NOT NULL,
	"started_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp(3) with time zone,
	CONSTRAINT "recovery_kind_check" CHECK ("recovery"."kind" IN ('automatic-failover','switchover','disaster-recovery')),
	CONSTRAINT "recovery_state_check" CHECK ("recovery"."state" IN ('detecting','fencing','promoting','repointing','reconciling-ingress','verifying','completed','failed','blocked'))
);
--> statement-breakpoint
CREATE TABLE "relay" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"fabric_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"address" "inet" NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"keepalive" integer,
	"endpoint_address" "inet",
	"public_key" text,
	"prefix" "cidr" NOT NULL,
	"advertised_cidrs" "cidr"[] DEFAULT '{}'::cidr[] NOT NULL,
	"preshared_key" text,
	CONSTRAINT "relay_fabric_server_unique" UNIQUE("fabric_id","server_id"),
	CONSTRAINT "uniq_relay_fabric_address" UNIQUE("fabric_id","address"),
	CONSTRAINT "uniq_relay_fabric_public_key" UNIQUE("fabric_id","public_key"),
	CONSTRAINT "relay_role_check" CHECK (role IN ('gateway', 'member')),
	CONSTRAINT "relay_keepalive_check" CHECK ("relay"."keepalive" IS NULL OR ("relay"."keepalive" BETWEEN 1 AND 65535)),
	CONSTRAINT "relay_member_advertised_cidrs_empty_check" CHECK ("relay"."role" <> 'member' OR cardinality("relay"."advertised_cidrs") = 0)
);
--> statement-breakpoint
CREATE TABLE "replica" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"managed_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"replica_class" text,
	"is_read_eligible" boolean DEFAULT false NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	"replication_transport" text,
	"private_port" integer,
	"status" text DEFAULT 'provisioning' NOT NULL,
	CONSTRAINT "uniq_replica_managed_ordinal" UNIQUE("managed_id","ordinal"),
	CONSTRAINT "uniq_replica_managed_server" UNIQUE("managed_id","server_id"),
	CONSTRAINT "replica_role_check" CHECK ("replica"."role" IN ('primary','replica')),
	CONSTRAINT "replica_replica_class_check" CHECK ("replica"."replica_class" IS NULL OR "replica"."replica_class" IN ('failover','read')),
	CONSTRAINT "replica_ordinal_positive_check" CHECK ("replica"."ordinal" >= 1),
	CONSTRAINT "replica_transport_check" CHECK ("replica"."replication_transport" IS NULL OR "replica"."replication_transport" IN ('local','fabric','datacenter','public')),
	CONSTRAINT "replica_status_check" CHECK (status IN ('provisioning','applying','ready','stopped','failed','needs_resync'))
);
--> statement-breakpoint
CREATE TABLE "repository" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"secret_id" uuid,
	"provider" text NOT NULL,
	"repository_url" text NOT NULL,
	"repository_external_id" text,
	"default_branch" varchar(255),
	"subdirectory" text,
	"auto_deploy" text DEFAULT 'disabled' NOT NULL,
	"detected_default_branch" varchar(255),
	"default_branch_checked_at" timestamp(3) with time zone,
	"last_inspected_at" timestamp(3) with time zone,
	"last_inspected_commit_sha" text,
	CONSTRAINT "uniq_repository_organization_url" UNIQUE("organization_id","repository_url"),
	CONSTRAINT "uniq_repository_organization_connection_repository" UNIQUE("organization_id","connection_id","repository_external_id"),
	CONSTRAINT "repository_provider_check" CHECK (provider IN ('github', 'gitlab', 'git')),
	CONSTRAINT "repository_auto_deploy_check" CHECK (auto_deploy IN ('immediate', 'checks_passed', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "retention" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"managed_id" uuid,
	"copy_id" uuid,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text,
	"retention_keep" integer NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp(3) with time zone,
	"created_by" uuid,
	CONSTRAINT "retention_target_kind_check" CHECK (target_kind IN ('managed', 'copy')),
	CONSTRAINT "retention_target_check" CHECK ((target_kind = 'managed' AND managed_id IS NOT NULL AND copy_id IS NULL) OR (target_kind = 'copy' AND copy_id IS NOT NULL AND managed_id IS NULL)),
	CONSTRAINT "retention_retention_keep_check" CHECK (retention_keep BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "scope" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"login_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	CONSTRAINT "uniq_scope_login_database" UNIQUE("login_id","database_id")
);
--> statement-breakpoint
CREATE TABLE "secret" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"organization_id" uuid NOT NULL,
	"principal_id" uuid,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"secret_envelope" text NOT NULL,
	CONSTRAINT "secret_provider_check" CHECK (provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key'))
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid,
	"name" text,
	"hostname" varchar(255),
	"machine_key" text,
	"os_id" varchar(255),
	"os_family" varchar(32),
	"os_version" varchar(64),
	"os_codename" varchar(64),
	"os_pretty_name" varchar(255),
	"os_architecture" varchar(64),
	"machine_class" text,
	"machine_class_source" text,
	"timezone" varchar(64),
	"is_time_sync_enabled" boolean,
	"ntp_servers" jsonb,
	"ntp_last_synced_at" timestamp(3) with time zone,
	"assigned_tier_id" uuid,
	"preferred_tier_id" uuid,
	"is_connected" boolean DEFAULT false NOT NULL,
	"status_changed_at" timestamp(3) with time zone,
	"daemon" jsonb,
	"is_hosting_enabled" boolean,
	"hardware" jsonb,
	"capability" jsonb,
	"offline_reason" text,
	"daemon_commit" text,
	"daemon_built_at" timestamp(3) with time zone,
	"daemon_update_status" text,
	"external_access_pending_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_server_machine_key" UNIQUE("machine_key"),
	CONSTRAINT "server_machine_class_check" CHECK ("server"."machine_class" IN ('physical', 'virtual')),
	CONSTRAINT "server_machine_class_source_check" CHECK (machine_class_source IN ('detected', 'operator')),
	CONSTRAINT "server_offline_reason_check" CHECK (offline_reason IN ('disconnect', 'sweep_stale')),
	CONSTRAINT "server_daemon_update_status_check" CHECK (daemon_update_status IN ('idle', 'updating', 'done', 'failed', 'expired'))
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
	"description" text,
	"compose_service_name" varchar(255) NOT NULL,
	"slug" text,
	"is_common" boolean DEFAULT false NOT NULL,
	CONSTRAINT "service_slug_check" CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$' AND slug !~ '\.\.'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"token" text NOT NULL,
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
CREATE TABLE "share" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"environment_id" uuid NOT NULL,
	"service_id" uuid,
	"storage_id" uuid,
	CONSTRAINT "share_asset_check" CHECK ((service_id IS NOT NULL AND storage_id IS NULL) OR (service_id IS NULL AND storage_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "slot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"environment_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"address" "inet",
	"slot" integer NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	CONSTRAINT "uniq_slot_service_slot" UNIQUE("service_id","slot"),
	CONSTRAINT "slot_slot_nonnegative_check" CHECK ("slot"."slot" >= 0),
	CONSTRAINT "slot_desired_state_check" CHECK ("slot"."desired_state" IN ('running','stopped','removed'))
);
--> statement-breakpoint
CREATE TABLE "snapshot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"retention_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"started_at" timestamp(3) with time zone NOT NULL,
	"finished_at" timestamp(3) with time zone NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"backup_ref" text,
	CONSTRAINT "snapshot_run_id_format_check" CHECK (run_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "snapshot_status_check" CHECK (status IN ('succeeded', 'failed')),
	CONSTRAINT "snapshot_backup_ref_format_check" CHECK (backup_ref IS NULL OR backup_ref ~ '^[A-Za-z0-9_-]+$')
);
--> statement-breakpoint
CREATE TABLE "ssh" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_type" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"comment" text,
	"user_id" uuid,
	"bits" integer,
	CONSTRAINT "ssh_fingerprint_unique" UNIQUE("principal_id","fingerprint"),
	CONSTRAINT "ssh_type_check" CHECK ("ssh"."key_type" IN ('ssh-ed25519', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', 'ssh-rsa')),
	CONSTRAINT "ssh_fingerprint_check" CHECK ("ssh"."fingerprint" ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
	CONSTRAINT "ssh_public_key_check" CHECK ("ssh"."public_key" ~ '^[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$'),
	CONSTRAINT "ssh_name_check" CHECK (char_length("ssh"."name") >= 1)
);
--> statement-breakpoint
CREATE TABLE "stage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"upgrade_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"phase" text DEFAULT 'fleet' NOT NULL,
	"batch_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp(3) with time zone,
	"from_version" text,
	"to_version" text,
	"from_commit" text,
	"to_commit" text,
	"status_changed_at" timestamp(3) with time zone,
	"error_code" text,
	"error_message" text,
	"detail" jsonb,
	CONSTRAINT "stage_unit_check" CHECK (unit IN ('daemon', 'instance')),
	CONSTRAINT "stage_phase_check" CHECK (phase IN ('colocated_daemon', 'control_plane', 'fleet')),
	CONSTRAINT "stage_status_check" CHECK (status IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying', 'done', 'failed', 'rolled_back', 'needs_attention', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "storage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"kind" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"access_mode" text DEFAULT 'single_writer' NOT NULL,
	"retention" text DEFAULT 'retain' NOT NULL,
	"principal_id" uuid,
	"content_envelope" text,
	"compose_volume_key" text,
	"slug" text,
	"is_common" boolean DEFAULT false NOT NULL,
	CONSTRAINT "storage_kind_check" CHECK (kind IN ('volume', 'directory', 'file', 'object')),
	CONSTRAINT "storage_access_mode_check" CHECK (access_mode IN ('single_writer', 'multi_reader', 'multi_writer')),
	CONSTRAINT "storage_retention_check" CHECK (retention IN ('retain', 'delete')),
	CONSTRAINT "storage_slug_check" CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$' AND slug !~ '\.\.')),
	CONSTRAINT "storage_at_most_one_parent_check" CHECK (((workspace_id IS NOT NULL)::int +
        (project_id IS NOT NULL)::int +
        (environment_id IS NOT NULL)::int +
        (service_id IS NOT NULL)::int) <= 1)
);
--> statement-breakpoint
CREATE TABLE "copy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"storage_id" uuid NOT NULL,
	"server_id" uuid,
	"secret_id" uuid,
	"provider" text NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"path" text,
	"endpoint" text,
	CONSTRAINT "copy_provider_check" CHECK (provider IN ('docker', 'path', 'block', 'nfs', 'cifs', 's3', 's3_compatible', 'sftp', 'ftp', 'webdav')),
	CONSTRAINT "copy_role_check" CHECK (role IN ('primary', 'replica', 'scratch', 'archive')),
	CONSTRAINT "copy_state_check" CHECK (state IN ('pending', 'materializing', 'ready', 'syncing', 'stale', 'failed', 'retiring'))
);
--> statement-breakpoint
CREATE TABLE "subnet" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"network_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"cidr" "cidr" NOT NULL,
	CONSTRAINT "subnet_network_server_unique" UNIQUE("network_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"payer_id" uuid NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"provider_status" text NOT NULL,
	"current_period_end" timestamp(3) with time zone,
	"schedule_id" text,
	"grace_expires_at" timestamp(3) with time zone,
	"past_due_since" timestamp(3) with time zone,
	CONSTRAINT "subscription_status_check" CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "seat" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"provider_item_id" text NOT NULL,
	"provider_price_id" text NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"command" text NOT NULL,
	"timezone" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"concurrency_policy" text DEFAULT 'forbid' NOT NULL,
	"timeout_seconds" integer,
	CONSTRAINT "uniq_task_service_name" UNIQUE("service_id","name"),
	CONSTRAINT "task_concurrency_policy_check" CHECK ("task"."concurrency_policy" IN ('allow','forbid','replace'))
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text,
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
CREATE TABLE "tenancy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"principal_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "tenancy_principal_service_unique" UNIQUE("principal_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "tier" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"label" text NOT NULL,
	"rank" integer NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"provider_product_id" text,
	"price_cents" integer,
	"currency" text,
	"is_custom" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tier_provider_check" CHECK (provider IN ('stripe'))
);
--> statement-breakpoint
CREATE TABLE "tls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" text,
	"source" text NOT NULL,
	"certificate_pem" text,
	"private_key_pem" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"not_after" timestamp(3) with time zone,
	"fingerprint_sha256" text,
	"ca_state" text,
	"ca_generation" integer,
	CONSTRAINT "tls_source_check" CHECK (source IN ('upload', 'lets_encrypt', 'self_signed', 'organization_ca')),
	CONSTRAINT "tls_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "tls_ca_state_check" CHECK (ca_state IS NULL OR ca_state IN ('active', 'retired', 'revoked')),
	CONSTRAINT "tls_ca_lifecycle_source_check" CHECK ((source = 'organization_ca' AND ca_state IS NOT NULL) OR (source <> 'organization_ca' AND ca_state IS NULL AND ca_generation IS NULL)),
	CONSTRAINT "tls_ca_generation_source_check" CHECK (ca_generation IS NULL OR source = 'organization_ca'),
	CONSTRAINT "tls_ca_generation_required_check" CHECK (ca_state IS NULL OR ca_state = 'revoked' OR ca_generation IS NOT NULL),
	CONSTRAINT "tls_status_check" CHECK (status IN ('ready', 'pending', 'expired', 'failed', 'revoked', 'managed'))
);
--> statement-breakpoint
CREATE TABLE "totp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"backup_codes" text NOT NULL,
	CONSTRAINT "uniq_totp_user_id" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "upgrade" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"target" jsonb,
	"preflight" jsonb,
	"source" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text,
	"started_by" uuid,
	"batch_policy" jsonb,
	"counts" jsonb,
	"error" text,
	"started_at" timestamp(3) with time zone,
	"finished_at" timestamp(3) with time zone,
	CONSTRAINT "upgrade_source_check" CHECK (source IN ('manual', 'auto', 'server')),
	CONSTRAINT "upgrade_status_check" CHECK (status IN ('pending', 'running', 'succeeded', 'partially_failed', 'failed', 'cancelled')),
	CONSTRAINT "upgrade_phase_check" CHECK (phase IS NULL OR phase IN ('colocated_daemon', 'control_plane', 'fleet'))
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"name" varchar(255),
	"email" varchar(255) NOT NULL,
	"is_email_verified" boolean DEFAULT false NOT NULL,
	"is_2fa_enabled" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"time_zone" varchar(64),
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_name_format_check" CHECK ((name IS NULL) OR ((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255))),
	CONSTRAINT "user_role_check" CHECK (role IN ('user', 'admin', 'superadmin'))
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
	"binding_id" uuid,
	"key" varchar(255) NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"is_literal" boolean DEFAULT false NOT NULL,
	"is_for_build" boolean DEFAULT false NOT NULL,
	"is_for_runtime" boolean DEFAULT true NOT NULL,
	"description" text,
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
CREATE TABLE "watch" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"repository_id" uuid NOT NULL,
	"environment_id" uuid,
	"project_id" uuid,
	CONSTRAINT "watch_target_check" CHECK ((environment_id IS NOT NULL AND project_id IS NULL) OR (environment_id IS NULL AND project_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"external_delivery_id" text NOT NULL,
	"event" text,
	"object_id" text,
	"object_type" text,
	"projected_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_delivery_provider_external" UNIQUE("provider","external_delivery_id"),
	CONSTRAINT "delivery_provider_check" CHECK (provider IN ('github', 'gitlab', 'stripe'))
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text,
	"description" text,
	"kind" varchar(32) DEFAULT 'user' NOT NULL,
	CONSTRAINT "workspace_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "workspace_kind_check" CHECK (kind IN ('user', 'turbopanel'))
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_tier_id_tier_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."tier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_copy_id_copy_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_retention_id_retention_id_fk" FOREIGN KEY ("retention_id") REFERENCES "public"."retention"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit" ADD CONSTRAINT "audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_retention_id_retention_id_fk" FOREIGN KEY ("retention_id") REFERENCES "public"."retention"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_login_id_login_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."login"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulwark" ADD CONSTRAINT "bulwark_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changeover" ADD CONSTRAINT "changeover_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command" ADD CONSTRAINT "command_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_last_command_id_command_id_fk" FOREIGN KEY ("last_command_id") REFERENCES "public"."command"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_command_id_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edict" ADD CONSTRAINT "edict_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edict" ADD CONSTRAINT "edict_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edict" ADD CONSTRAINT "edict_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fabric" ADD CONSTRAINT "fabric_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge" ADD CONSTRAINT "forge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_forge_id_forge_id_fk" FOREIGN KEY ("forge_id") REFERENCES "public"."forge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_tls_id_tls_id_fk" FOREIGN KEY ("tls_id") REFERENCES "public"."tls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_ip_id_ip_id_fk" FOREIGN KEY ("ip_id") REFERENCES "public"."ip"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostname" ADD CONSTRAINT "hostname_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostname" ADD CONSTRAINT "hostname_routing_organization_id_organization_id_fk" FOREIGN KEY ("routing_organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_uploaded_cert_id_certificate_id_fk" FOREIGN KEY ("uploaded_cert_id") REFERENCES "public"."certificate"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip" ADD CONSTRAINT "ip_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key" ADD CONSTRAINT "key_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_replica_id_replica_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."replica"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_ca_id_tls_id_fk" FOREIGN KEY ("ca_id") REFERENCES "public"."tls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease" ADD CONSTRAINT "lease_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license" ADD CONSTRAINT "license_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login" ADD CONSTRAINT "login_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed" ADD CONSTRAINT "managed_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database" ADD CONSTRAINT "database_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database" ADD CONSTRAINT "database_owner_login_id_login_id_fk" FOREIGN KEY ("owner_login_id") REFERENCES "public"."login"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marker" ADD CONSTRAINT "marker_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount" ADD CONSTRAINT "mount_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network" ADD CONSTRAINT "network_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_server_id_server_id_fk" FOREIGN KEY ("default_server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery" ADD CONSTRAINT "recovery_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery" ADD CONSTRAINT "recovery_target_member_id_replica_id_fk" FOREIGN KEY ("target_member_id") REFERENCES "public"."replica"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay" ADD CONSTRAINT "relay_fabric_id_fabric_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabric"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay" ADD CONSTRAINT "relay_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replica" ADD CONSTRAINT "replica_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replica" ADD CONSTRAINT "replica_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_copy_id_copy_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."copy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention" ADD CONSTRAINT "retention_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_login_id_login_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."login"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_assigned_tier_id_tier_id_fk" FOREIGN KEY ("assigned_tier_id") REFERENCES "public"."tier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_preferred_tier_id_tier_id_fk" FOREIGN KEY ("preferred_tier_id") REFERENCES "public"."tier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot" ADD CONSTRAINT "slot_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot" ADD CONSTRAINT "slot_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot" ADD CONSTRAINT "slot_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_retention_id_retention_id_fk" FOREIGN KEY ("retention_id") REFERENCES "public"."retention"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh" ADD CONSTRAINT "ssh_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh" ADD CONSTRAINT "ssh_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_upgrade_id_upgrade_id_fk" FOREIGN KEY ("upgrade_id") REFERENCES "public"."upgrade"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy" ADD CONSTRAINT "copy_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy" ADD CONSTRAINT "copy_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy" ADD CONSTRAINT "copy_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subnet" ADD CONSTRAINT "subnet_network_id_network_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."network"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subnet" ADD CONSTRAINT "subnet_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_payer_id_payer_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."payer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_tier_id_tier_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."tier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate" ADD CONSTRAINT "teammate_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy" ADD CONSTRAINT "tenancy_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenancy" ADD CONSTRAINT "tenancy_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp" ADD CONSTRAINT "totp_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrade" ADD CONSTRAINT "upgrade_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable" ADD CONSTRAINT "variable_binding_id_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."binding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch" ADD CONSTRAINT "watch_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch" ADD CONSTRAINT "watch_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch" ADD CONSTRAINT "watch_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_allowance_organization" ON "allowance" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_allowance_tier_id" ON "allowance" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "idx_archive_copy_id_created_at" ON "archive" USING btree ("copy_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_archive_retention_id" ON "archive" USING btree ("retention_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_archive_copy_backup_id" ON "archive" USING btree ("copy_id","backup_id");--> statement-breakpoint
CREATE INDEX "idx_audit_organization_recent" ON "audit" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_backup_managed_id_created_at" ON "backup" USING btree ("managed_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_backup_retention_id" ON "backup" USING btree ("retention_id");--> statement-breakpoint
CREATE INDEX "idx_backup_server_id" ON "backup" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_backup_database_id" ON "backup" USING btree ("database_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_backup_managed_backup_id" ON "backup" USING btree ("managed_id","backup_id");--> statement-breakpoint
CREATE INDEX "idx_binding_database_id" ON "binding" USING btree ("database_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_binding_login_id" ON "binding" USING btree ("login_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_binding_service_engine_defaults" ON "binding" USING btree ("service_id") WHERE "binding"."is_emit_engine_defaults";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bulwark_server_id" ON "bulwark" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_changeover_organization_id" ON "changeover" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_changeover_inflight_organization" ON "changeover" USING btree ("organization_id") WHERE "changeover"."state" = 'in_progress';--> statement-breakpoint
CREATE INDEX "idx_address_organization_id" ON "address" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_address_server_id" ON "address" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_address_datacenter_id" ON "address" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_address_server_public" ON "address" USING btree ("server_id") WHERE "address"."scope" = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_address_server_datacenter" ON "address" USING btree ("server_id","datacenter_id") WHERE "address"."datacenter_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_address_server_primary" ON "address" USING btree ("server_id") WHERE "address"."is_primary";--> statement-breakpoint
CREATE INDEX "idx_command_managed_destroy_gate_id" ON "command" USING btree ("managed_destroy_gate_id" text_ops) WHERE "command"."managed_destroy_gate_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_command_server_recent" ON "command" USING btree ("server_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_command_open" ON "command" USING btree ("status","updated_at") WHERE "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running');--> statement-breakpoint
CREATE INDEX "idx_command_managed" ON "command" USING btree ("managed_id") WHERE "command"."managed_id" IS NOT NULL AND "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running');--> statement-breakpoint
CREATE INDEX "idx_command_feed" ON "command" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" IN ('environment.deploy', 'environment.lifecycle', 'environment.stop') AND "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running', 'failed', 'timed_out');--> statement-breakpoint
CREATE INDEX "idx_command_server_id_name_created_at" ON "command" USING btree ("server_id","name","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_command_deploy" ON "command" USING btree ("environment_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" = 'environment.deploy';--> statement-breakpoint
CREATE INDEX "idx_container_server_id" ON "container" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_container_status" ON "container" USING btree ("status" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_server_container_id" ON "container" USING btree ("server_id","container_id") WHERE container_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_service_role_ordinal" ON "container" USING btree ("service_id","role","ordinal");--> statement-breakpoint
CREATE INDEX "idx_datacenter_organization_id" ON "datacenter" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deployment_server_id" ON "deployment" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deployment_last_command" ON "deployment" USING btree ("last_command_id") WHERE "deployment"."last_command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dispatch_expires_at" ON "dispatch" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_edict_organization_id" ON "edict" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_edict_server_id" ON "edict" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_edict_created_by" ON "edict" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_environment_project_id" ON "environment" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_server_id" ON "environment" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fabric_organization_id" ON "fabric" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_folder_location" ON "folder" USING btree ("server_id","principal_id","scope","kind","slug");--> statement-breakpoint
CREATE INDEX "idx_folder_principal_id" ON "folder" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_environment_id" ON "folder" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_service_id" ON "folder" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_storage_id" ON "folder" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_forge_organization_id" ON "forge" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_connection_forge_id" ON "connection" USING btree ("forge_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_connection_forge_external_github" ON "connection" USING btree ("forge_id","external_installation_id") WHERE "connection"."provider" = 'github';--> statement-breakpoint
CREATE INDEX "idx_permission_actor" ON "permission" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_hosting_pending" ON "hosting" USING btree ("updated_at") WHERE "hosting"."pending_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_hosting_service_id" ON "hosting" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_tls_id" ON "hosting" USING btree ("tls_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_ip_id" ON "hosting" USING btree ("ip_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hostname_hosting_id" ON "hostname" USING btree ("hosting_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_origin_uploaded_cert_id" ON "origin" USING btree ("uploaded_cert_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_invitation_token_hash" ON "invitation" USING btree ("token_hash" text_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_email" ON "invitation" USING btree ("email" text_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_user_id" ON "invitation" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_invitation_team_id" ON "invitation" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_datacenter_id" ON "ip" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_network_id" ON "ip" USING btree ("network_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_server_id" ON "ip" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_scope_server_datacenter" ON "ip" USING btree ("scope" text_ops,"server_id" uuid_ops,"datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_ip_repin_pending_fanout_at" ON "ip" USING btree ("repin_pending_fanout_at" timestamptz_ops) WHERE "ip"."repin_pending_fanout_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ip_org_address" ON "ip" USING btree ("organization_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_key_server" ON "key" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_key_fingerprint" ON "key" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "idx_leaf_not_after" ON "leaf" USING btree ("not_after" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_organization_id" ON "leaf" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_ca_id" ON "leaf" USING btree ("ca_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_managed_id" ON "leaf" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_leaf_server_id" ON "leaf" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leaf_ingress_server" ON "leaf" USING btree ("server_id") WHERE "leaf"."kind" = 'ingress';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leaf_engine_replica" ON "leaf" USING btree ("replica_id") WHERE "leaf"."kind" = 'engine';--> statement-breakpoint
CREATE INDEX "idx_leaf_replica_id" ON "leaf" USING btree ("replica_id");--> statement-breakpoint
CREATE INDEX "idx_lease_organization_id" ON "lease" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_license_organization_id" ON "license" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_license_server_id" ON "license" USING btree ("server_id") WHERE "license"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_license_server_id" ON "license" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_login_principal_id" ON "login" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_principal" ON "login" USING btree ("managed_id","principal_id") WHERE "login"."principal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_applied_username" ON "login" USING btree ("managed_id",lower(btrim(("applied_username")::text)));--> statement-breakpoint
CREATE INDEX "idx_managed_server_id" ON "managed" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_managed_engine" ON "managed" USING btree ("engine" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "managed_environment_id_unique" ON "managed" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_database_managed_name" ON "database" USING btree ("managed_id",lower("name"));--> statement-breakpoint
CREATE INDEX "idx_database_owner_login_id" ON "database" USING btree ("owner_login_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_tag_id" ON "marker" USING btree ("tag_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_server_id" ON "marker" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_workspace_id" ON "marker" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_project_id" ON "marker" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_environment_id" ON "marker" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_service_id" ON "marker" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_datacenter_id" ON "marker" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_marker_storage_id" ON "marker" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_server" ON "marker" USING btree ("tag_id","server_id") WHERE "marker"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_workspace" ON "marker" USING btree ("tag_id","workspace_id") WHERE "marker"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_project" ON "marker" USING btree ("tag_id","project_id") WHERE "marker"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_environment" ON "marker" USING btree ("tag_id","environment_id") WHERE "marker"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_service" ON "marker" USING btree ("tag_id","service_id") WHERE "marker"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_datacenter" ON "marker" USING btree ("tag_id","datacenter_id") WHERE "marker"."datacenter_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_marker_storage" ON "marker" USING btree ("tag_id","storage_id") WHERE "marker"."storage_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_monitor_server" ON "monitor" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_mount_storage_id" ON "mount" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_server_id" ON "network" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_organization_id" ON "network" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_datacenter_id" ON "network" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_network_environment_id" ON "network" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_network_datacenter_cidr" ON "network" USING btree ("datacenter_id","cidr") WHERE "network"."kind" = 'datacenter';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_network_organization_managed" ON "network" USING btree ("organization_id") WHERE "network"."kind" = 'managed';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_network_environment_compose_key" ON "network" USING btree ("environment_id","compose_key") WHERE "network"."kind" = 'compose';--> statement-breakpoint
CREATE INDEX "idx_notification_user_created" ON "notification" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notification_unread" ON "notification" USING btree ("user_id") WHERE "notification"."read_at" IS NULL AND "notification"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notification_organization_id" ON "notification" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_channel_organization" ON "channel" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_channel_user" ON "channel" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_channel_created_by_user_id" ON "channel" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_attempt_pending" ON "attempt" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_attempt_held" ON "attempt" USING btree ("channel_id","created_at") WHERE status = 'held';--> statement-breakpoint
CREATE INDEX "idx_attempt_channel_created" ON "attempt" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_attempt_organization_id" ON "attempt" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_rule_channel_event" ON "rule" USING btree ("channel_id","event");--> statement-breakpoint
CREATE INDEX "idx_passkey_user_id" ON "passkey" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_payer_organization_id" ON "payer" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_payer_user_id" ON "payer" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payer_provider_customer" ON "payer" USING btree ("provider","provider_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payer_organization_provider" ON "payer" USING btree ("organization_id","provider") WHERE "payer"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payer_user_provider" ON "payer" USING btree ("user_id","provider") WHERE "payer"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_principal_organization_id" ON "principal" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_project_id" ON "principal" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_username" ON "principal" USING btree ("organization_id",lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_applied_username" ON "principal" USING btree ("organization_id",lower("applied_username"));--> statement-breakpoint
CREATE INDEX "idx_placement_server_id" ON "placement" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_placement_server_uid" ON "placement" USING btree ("server_id","uid") WHERE "placement"."uid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_project_default_server_id" ON "project" USING btree ("default_server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_workspace_id" ON "project" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_repository_id" ON "project" USING btree ("repository_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_organization_id" ON "project" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_organization_name" ON "project" USING btree ("organization_id",lower(btrim(("name")::text))) WHERE name IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_workspace_system_component" ON "project" USING btree ("workspace_id","component") WHERE component IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_recovery_managed_id" ON "recovery" USING btree ("managed_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_recovery_inflight_managed" ON "recovery" USING btree ("managed_id") WHERE "recovery"."state" NOT IN ('completed','failed','blocked');--> statement-breakpoint
CREATE INDEX "idx_relay_server_id" ON "relay" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_replica_server_id" ON "replica" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_replica_primary" ON "replica" USING btree ("managed_id") WHERE "replica"."role" = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_replica_server_private_port" ON "replica" USING btree ("server_id","private_port") WHERE "replica"."private_port" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_repository_connection_external" ON "repository" USING btree ("connection_id","repository_external_id");--> statement-breakpoint
CREATE INDEX "idx_repository_secret_id" ON "repository" USING btree ("secret_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_retention_organization_id" ON "retention" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_retention_managed_id" ON "retention" USING btree ("managed_id");--> statement-breakpoint
CREATE INDEX "idx_retention_copy_id" ON "retention" USING btree ("copy_id");--> statement-breakpoint
CREATE INDEX "idx_retention_created_by" ON "retention" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_scope_database_id" ON "scope" USING btree ("database_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_secret_organization_id" ON "secret" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_secret_principal_id" ON "secret" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_organization_id" ON "server" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_connected" ON "server" USING btree ("id") WHERE "server"."is_connected";--> statement-breakpoint
CREATE INDEX "idx_server_offline" ON "server" USING btree ("status_changed_at" DESC NULLS LAST) WHERE "server"."is_connected" = false;--> statement-breakpoint
CREATE INDEX "idx_server_updating" ON "server" USING btree ("id") WHERE "server"."daemon_update_status" = 'updating';--> statement-breakpoint
CREATE INDEX "idx_server_assigned_tier_id" ON "server" USING btree ("assigned_tier_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_server_preferred_tier_id" ON "server" USING btree ("preferred_tier_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_service_environment_compose_name" ON "service" USING btree ("environment_id","compose_service_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_service_environment_slug" ON "service" USING btree ("environment_id","slug") WHERE slug IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_session_user_id" ON "session" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_share_environment_id" ON "share" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_share_service_id" ON "share" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_share_storage_id" ON "share" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_share_environment_service" ON "share" USING btree ("environment_id","service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_share_environment_storage" ON "share" USING btree ("environment_id","storage_id") WHERE storage_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_slot_environment_generation" ON "slot" USING btree ("environment_id","generation");--> statement-breakpoint
CREATE INDEX "idx_slot_server_id" ON "slot" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_snapshot_retention_id_started_at" ON "snapshot" USING btree ("retention_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_snapshot_server_id" ON "snapshot" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_snapshot_retention_run_id" ON "snapshot" USING btree ("retention_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_ssh_fingerprint" ON "ssh" USING btree ("fingerprint" text_ops);--> statement-breakpoint
CREATE INDEX "idx_ssh_user_id" ON "ssh" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_stage_upgrade_status" ON "stage" USING btree ("upgrade_id","status");--> statement-breakpoint
CREATE INDEX "idx_stage_upgrade_phase" ON "stage" USING btree ("upgrade_id","phase","batch_index","status");--> statement-breakpoint
CREATE INDEX "idx_stage_server_created" ON "stage" USING btree ("server_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_stage_active_next_attempt" ON "stage" USING btree ("status","next_attempt_at") WHERE "stage"."status" IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying');--> statement-breakpoint
CREATE INDEX "idx_storage_organization_id" ON "storage" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_workspace_id" ON "storage" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_project_id" ON "storage" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_environment_id" ON "storage" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_service_id" ON "storage" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_storage_principal_id" ON "storage" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_storage_environment_compose_volume_key" ON "storage" USING btree ("environment_id","compose_volume_key") WHERE kind = 'volume'
          AND environment_id IS NOT NULL
          AND compose_volume_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_copy_storage_id" ON "copy" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_copy_server_id" ON "copy" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_copy_secret_id" ON "copy" USING btree ("secret_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_copy_storage_primary" ON "copy" USING btree ("storage_id") WHERE "copy"."role" = 'primary';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_copy_storage_server_provider" ON "copy" USING btree ("storage_id","server_id","provider") WHERE "copy"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_subnet_server_id" ON "subnet" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_subscription_payer_id" ON "subscription" USING btree ("payer_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_subscription_provider_id" ON "subscription" USING btree ("provider_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_seat_tier_id" ON "seat" USING btree ("tier_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_seat_provider_item" ON "seat" USING btree ("provider_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_seat_subscription_tier" ON "seat" USING btree ("subscription_id","tier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tag_organization_name" ON "tag" USING btree ("organization_id",lower(btrim(("name")::text)));--> statement-breakpoint
CREATE INDEX "idx_team_organization_id" ON "team" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_teammate_user_id" ON "teammate" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tenancy_service_id" ON "tenancy" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tier_label" ON "tier" USING btree ("label");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tier_rank" ON "tier" USING btree ("rank");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tier_provider_product" ON "tier" USING btree ("provider","provider_product_id") WHERE "tier"."provider_product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_tls_organization_id" ON "tls" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tls_not_after" ON "tls" USING btree ("not_after" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tls_organization_fingerprint_sha256" ON "tls" USING btree ("organization_id","fingerprint_sha256") WHERE "tls"."fingerprint_sha256" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tls_organization_active_ca" ON "tls" USING btree ("organization_id") WHERE "tls"."source" = 'organization_ca' AND "tls"."ca_state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_tls_organization_ca_generation" ON "tls" USING btree ("organization_id","ca_generation") WHERE "tls"."source" = 'organization_ca';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_upgrade_active" ON "upgrade" USING btree ((true)) WHERE "upgrade"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_upgrade_started_by" ON "upgrade" USING btree ("started_by");--> statement-breakpoint
CREATE INDEX "idx_variable_organization_id" ON "variable" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_workspace_id" ON "variable" USING btree ("workspace_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_project_id" ON "variable" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_environment_id" ON "variable" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_service_id" ON "variable" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_hosting_id" ON "variable" USING btree ("hosting_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_server_id" ON "variable" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_variable_binding_id" ON "variable" USING btree ("binding_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_org" ON "variable" USING btree ("key","organization_id") WHERE "variable"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_workspace" ON "variable" USING btree ("key","workspace_id") WHERE "variable"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_project" ON "variable" USING btree ("key","project_id") WHERE "variable"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_environment" ON "variable" USING btree ("key","environment_id") WHERE "variable"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_service" ON "variable" USING btree ("key","service_id") WHERE "variable"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_hosting" ON "variable" USING btree ("key","hosting_id") WHERE "variable"."hosting_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_var_server" ON "variable" USING btree ("key","server_id") WHERE "variable"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_watch_repository_environment" ON "watch" USING btree ("repository_id","environment_id") WHERE "watch"."environment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_watch_repository_project" ON "watch" USING btree ("repository_id","project_id") WHERE "watch"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_watch_environment_id" ON "watch" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_watch_project_id" ON "watch" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_delivery_created_at" ON "delivery" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_delivery_pending" ON "delivery" USING btree ("updated_at") WHERE "delivery"."provider" = 'stripe' AND "delivery"."projected_at" IS NULL AND "delivery"."object_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_workspace_organization_id" ON "workspace" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workspace_organization_turbopanel" ON "workspace" USING btree ("organization_id") WHERE kind = 'turbopanel';
--> statement-breakpoint
COMMENT ON TABLE "account" IS 'One sign-in credential per user and provider: the local password account (`credential`) or a linked GitHub/Google identity; unique on provider plus subject.';--> statement-breakpoint
COMMENT ON COLUMN "account"."provider_id" IS '`credential` for the local password account, or the OAuth provider id `github` or `google` for a linked identity.';--> statement-breakpoint
COMMENT ON COLUMN "account"."provider_user_id" IS 'Provider-side subject: the user''s own uuid on `credential` rows, else the GitHub/Google account id; unique together with `provider_id`.';--> statement-breakpoint
COMMENT ON COLUMN "account"."password" IS 'Argon2id PHC-format hash (`$argon2id$v=19$m=N,t=N,p=N$salt$digest`) on `credential` rows, set at sign-up, install and password reset; null on OAuth rows.';--> statement-breakpoint
COMMENT ON TABLE "allowance" IS 'Self-hosted entitlement grant: at most one row per organization giving `quantity` free units at the custom `SX` tier so assignment runs with no subscription.';--> statement-breakpoint
COMMENT ON COLUMN "allowance"."organization_id" IS 'Organization holding the grant; unique (`uniq_allowance_organization`), so an organization has zero or one row.';--> statement-breakpoint
COMMENT ON COLUMN "allowance"."tier_id" IS 'Always the `SX` custom-rung tier row (`ensureCustomTierRow`), stored rather than looked up by label so entitlement reads on the ingest path add no query.';--> statement-breakpoint
COMMENT ON COLUMN "allowance"."quantity" IS 'Free `SX` units the self-hosted runtime grants to match its active licenses; always at least 1 because writing zero deletes the row instead.';--> statement-breakpoint
COMMENT ON TABLE "archive" IS 'One completed storage-copy backup artifact recorded from a daemon report; unique per (copy_id, backup_id), cascades with the copy.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."retention_id" IS 'The `retention` whose scheduled run made this artifact; null for a manual backup or once that retention is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."backup_id" IS 'Daemon-minted `bk_` plus hex token that is also the artifact filename on the host; unique per storage copy, not globally.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."size_bytes" IS 'Artifact size in bytes as reported by the daemon after writing the archive; re-checked before a restore.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."checksum" IS 'Lowercase SHA-256 hex digest of the artifact computed by the daemon; a restore refuses on mismatch.';--> statement-breakpoint
COMMENT ON COLUMN "archive"."path" IS 'Artifact path relative to the backup root of the copy''s server (`volumes/` plus the copy id, then the file).';--> statement-breakpoint
COMMENT ON TABLE "audit" IS 'Append-only trail of security-relevant operator actions (rows never updated or deleted, no `updated_at`), written by `recordAudit` after the action succeeded.';--> statement-breakpoint
COMMENT ON COLUMN "audit"."organization_id" IS 'Organization the action belongs to, which the org-scoped read filters on; null for an instance-wide action such as a superadmin editing an org-less forge.';--> statement-breakpoint
COMMENT ON COLUMN "audit"."actor_user_id" IS 'User who acted, a plain id with no FK so it survives the account''s deletion; null only for an action the platform took on nobody''s behalf.';--> statement-breakpoint
COMMENT ON COLUMN "audit"."actor_email" IS 'Actor''s email denormalised at write time so the trail still names who acted after the account is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "audit"."action" IS 'Dot-joined subject and verb from `AUDIT_ACTIONS` (such as `server.delete`, `grant.create`, `organization.acme.set`); a label only, not CHECKed so it can grow.';--> statement-breakpoint
COMMENT ON COLUMN "audit"."target_type" IS 'What the action was done to: `organization`, `server`, `forge`, or the `entity_type` of the grant being created or deleted.';--> statement-breakpoint
COMMENT ON COLUMN "audit"."target_id" IS 'Id of the target row when there is one (server, forge, organization or grant entity); nullable and without an FK so the trail outlives the target.';--> statement-breakpoint
COMMENT ON COLUMN "audit"."context" IS 'Small non-secret JSON facts kept beside the action, such as `purged`, `acmeEnabled`, `deployHooksEnabled` or the grant details; never a credential.';--> statement-breakpoint
COMMENT ON TABLE "backup" IS 'One completed managed-engine backup artifact recorded from the daemon''s `managed.backup` result; unique per (managed_id, backup_id), cascades with the cluster.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."backup_id" IS 'Daemon-minted `bk_` plus hex token that is also the artifact filename on the host; unique per managed engine, not globally.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."size_bytes" IS 'Artifact size in bytes as reported by the daemon after writing the dump; re-checked before a restore.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."checksum" IS 'Lowercase SHA-256 hex digest of the artifact computed by the daemon; a restore refuses on mismatch.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."database" IS 'Database name for a single-database backup, kept as history; null for an instance-scope backup.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."database_id" IS 'The `database` row the dump was of, set null if that database is dropped; null for an instance-scope backup.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."path" IS 'Artifact path relative to the backup root of the host that made it (`managed/` plus the cluster id, then the file).';--> statement-breakpoint
COMMENT ON COLUMN "backup"."retention_id" IS 'The `retention` whose scheduled run made this artifact; null for a manual backup or once that retention is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "backup"."server_id" IS 'Host that holds the on-disk artifact (the primary when the backup ran); null on older rows or after that server is deleted.';--> statement-breakpoint
COMMENT ON TABLE "binding" IS 'Join edge attaching a database login to a consuming compose service; materializes system-owned `variable` rows for deploy credential injection.';--> statement-breakpoint
COMMENT ON COLUMN "binding"."login_id" IS 'The `login` row whose credentials are injected; cascade-deleted with it (login gone, binding gone).';--> statement-breakpoint
COMMENT ON COLUMN "binding"."service_id" IS 'Consuming compose service; ON DELETE RESTRICT so a service with bindings cannot be deleted.';--> statement-breakpoint
COMMENT ON COLUMN "binding"."database_id" IS 'The `database` the credentials point at; ON DELETE RESTRICT so a database in use cannot be dropped.';--> statement-breakpoint
COMMENT ON COLUMN "binding"."key_prefix" IS 'Environment variable prefix for the emitted credential keys (default `DATABASE`), unique per service; identifier charset, 1-64 chars.';--> statement-breakpoint
COMMENT ON COLUMN "binding"."is_emit_engine_defaults" IS 'When true, also emit the unprefixed conventional engine keys (PG*, MYSQL_*); at most one such binding per service (API field `emitEngineDefaults`).';--> statement-breakpoint
COMMENT ON TABLE "bulwark" IS 'One server''s firewall state: its mode, the generation last sent, what the host last answered, and whether the last ruleset was kept.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."server_id" IS 'The server this state belongs to; one row per server, cascade-deleted with it.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."mode" IS '`observe` shows the ruleset and applies nothing (the default), `managed` enforces it and `off` leaves the firewall alone.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."generation" IS 'Rises by one each time the desired ruleset changes, so a host can tell a stale push from a current one.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_digest" IS 'The sha256 hex the host last reported for its rendered rulesets; the drift key.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_result" IS 'What the host last answered: applied or refused, the rule count and any warnings; null before any report.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_kind" IS 'Which kind of record `last_result` holds: `preview`, `apply` or `remove`; the firewall sweep filters on it, and it is null before any record.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."state" IS '`idle`, `pending` (awaiting confirmation), `confirmed` or `rolled_back` (undone by the host guard).';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."deadline_at" IS 'When the host guard undoes an unconfirmed ruleset; null unless `state` is `pending`.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."last_applied_at" IS 'When the host last applied a ruleset; null before the first.';--> statement-breakpoint
COMMENT ON COLUMN "bulwark"."confirmed_at" IS 'When the last ruleset was confirmed as keeping the host reachable; null before the first.';--> statement-breakpoint
COMMENT ON TABLE "changeover" IS 'Journal row for one Organization CA rotation (at most one `in_progress` per org); never deleted, it is the audit trail and resume state of the fan-out.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."metadata" IS 'Fan-out resume state written between passes: `resumeAfterManagedId` keyset cursor and `needsRedeploy` server/environment pairs.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."organization_id" IS 'Owning org; the partial unique index allows one `in_progress` row per org, which is what makes the row act as the rotation lease.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."from_ca_generation" IS 'Generation that was active when the rotation minted its successor; 0 until the mint step has run.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."to_ca_generation" IS 'New active generation minted by this rotation; 0 until minted, and a non-zero value lets a repeated request resume fan-out.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."state" IS '`in_progress` (lease held), then `awaiting_retire` once fan-out converged, then `completed` when the old generation is retired, or `failed`.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."started_at" IS 'When the lease was taken; reset when a stale in-progress row (older than 15 min) is stolen by another isolate.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."completed_at" IS 'Set by the retire step together with `state` = `completed`; null otherwise and cleared when a stale row is stolen.';--> statement-breakpoint
COMMENT ON COLUMN "changeover"."results" IS 'Array of per-server fan-out rows with `serverId`, `kind` (`ingress`, `apply` or `binding`), `managedId`, `commandId`, `status` and `error`.';--> statement-breakpoint
COMMENT ON TABLE "address" IS 'An address clients use to reach a server, set by an operator: one `public` entry per server and one per datacenter the server belongs to.';--> statement-breakpoint
COMMENT ON COLUMN "address"."options" IS 'External port per listener under `ports` (`postgres`, `mysql`, `http`, `https`); absent = the listen port, null = not reachable here.';--> statement-breakpoint
COMMENT ON COLUMN "address"."organization_id" IS 'Organization that owns the server, copied from it on save; entries cascade away with the organization.';--> statement-breakpoint
COMMENT ON COLUMN "address"."server_id" IS 'The server this entry belongs to; entries cascade away when the server is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "address"."scope" IS 'Which side of the server this entry describes: `public`, or `datacenter` for one datacenter the server belongs to.';--> statement-breakpoint
COMMENT ON COLUMN "address"."datacenter_id" IS 'The datacenter whose address this entry names; set if and only if `scope = ''datacenter''`; cascades away with the datacenter.';--> statement-breakpoint
COMMENT ON COLUMN "address"."hostname" IS 'Optional DNS name clients type, lower case and always containing a dot; it fills connection strings and goes on the database certificate.';--> statement-breakpoint
COMMENT ON COLUMN "address"."address_v4" IS 'Optional IPv4 address clients use when it is not the server''s own, such as a router; NULL = the server''s own address on that side.';--> statement-breakpoint
COMMENT ON COLUMN "address"."address_v6" IS 'Optional IPv6 address clients use when it is not the server''s own; NULL = the server''s own address on that side.';--> statement-breakpoint
COMMENT ON COLUMN "address"."is_primary" IS 'True on the entry that fills the main connection string, at most one per server; with none marked the public entry is used.';--> statement-breakpoint
COMMENT ON TABLE "command" IS 'Append-only command history, one row per attempt dispatched to a daemon; created by routes and reconcilers, advanced by `transitionCommand`; UI status source.';--> statement-breakpoint
COMMENT ON COLUMN "command"."metadata" IS 'Follow-up-chain blob only (`pendingStandbyApplies`, `managedDestroyGate`, `followUpPromote`, `pendingTlsLeaf`, `desiredHash`) and one-shot claim flags.';--> statement-breakpoint
COMMENT ON COLUMN "command"."actor_type" IS '`user` for an operator request or `system` for the control plane''s own reconcilers, sweeps and webhooks (mirrors `COMMAND_ACTOR_TYPES`); no FK.';--> statement-breakpoint
COMMENT ON COLUMN "command"."actor_id" IS 'Id of the acting user, or of the triggering entity (usually the server) when `actor_type` is `system`; no FK.';--> statement-breakpoint
COMMENT ON COLUMN "command"."name" IS 'Command type from `COMMAND_TYPES` in commands/types.ts, such as `daemon.ping`, `environment.deploy`, `managed.apply` or `system.reconcile`.';--> statement-breakpoint
COMMENT ON COLUMN "command"."status" IS 'State `queued`, `dispatching`, `sent`, `acked`, `running`, then terminal `succeeded`, `failed`, `timed_out` or `cancelled`; set by `transitionCommand`.';--> statement-breakpoint
COMMENT ON COLUMN "command"."attempts" IS 'Dispatch retry count, incremented by the queue consumer each time it picks the command up.';--> statement-breakpoint
COMMENT ON COLUMN "command"."context" IS 'Allowlisted non-secret identifier bag (`managedId`, `environmentId`, `generation`) extracted by commands/context.ts so reads never need the dispatch payload.';--> statement-breakpoint
COMMENT ON COLUMN "command"."result_summary" IS 'Small bounded typed result reported by the daemon on completion (API field `result`); execution logs live in the execution-log store, not here.';--> statement-breakpoint
COMMENT ON COLUMN "command"."progress" IS 'Live step plan and current step the server reports during a deploy (`CommandProgress`); NULL until reported, finalised when the command ends.';--> statement-breakpoint
COMMENT ON COLUMN "command"."error_code" IS 'Machine-readable terminal error code set when the command fails or times out.';--> statement-breakpoint
COMMENT ON COLUMN "command"."error_message" IS 'Human-readable terminal error text (API field `error`) set alongside `error_code`.';--> statement-breakpoint
COMMENT ON COLUMN "command"."queued_at" IS 'Set by `transitionCommand` when the status becomes `queued`.';--> statement-breakpoint
COMMENT ON COLUMN "command"."dispatch_started_at" IS 'Set when the queue consumer picks the command up (status `dispatching`).';--> statement-breakpoint
COMMENT ON COLUMN "command"."sent_at" IS 'Set when the command is enqueued to the daemon cell outbox (status `sent`).';--> statement-breakpoint
COMMENT ON COLUMN "command"."acked_at" IS 'Set when the daemon acknowledges receipt (status `acked`).';--> statement-breakpoint
COMMENT ON COLUMN "command"."started_at" IS 'Set when the daemon reports that execution has begun (status `running`).';--> statement-breakpoint
COMMENT ON COLUMN "command"."finished_at" IS 'Set when the command reaches any terminal status.';--> statement-breakpoint
COMMENT ON COLUMN "command"."expires_at" IS 'Optional deadline: once passed, the consumer marks the command `timed_out` instead of dispatching it; consumer-made follow-ups set 10 minutes, NULL means none.';--> statement-breakpoint
COMMENT ON COLUMN "command"."managed_destroy_gate_id" IS '`metadata.managedDestroyGate.gateId` promoted to an indexed column so gated replica-destroy completions can be filtered; `memberIds` stays in jsonb.';--> statement-breakpoint
COMMENT ON COLUMN "command"."organization_id" IS 'Organization of the server, copied at insert so the activity feed and org-wide lists filter without a join; set null if the organization row goes.';--> statement-breakpoint
COMMENT ON COLUMN "command"."environment_id" IS 'Environment a deploy, lifecycle or stop command was issued for (also kept in `context`); set null when the environment is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "command"."managed_id" IS 'Managed cluster the command acts on (also kept in `context`); set null when the cluster is deleted.';--> statement-breakpoint
COMMENT ON TABLE "container" IS 'Pins one Docker container to a service and the server observed to host it; rows are pre-allocated at deploy and upserted from the daemon''s post-deploy report.';--> statement-breakpoint
COMMENT ON COLUMN "container"."metadata" IS 'Free-form jsonb accepted from `POST /containers` and `PATCH` with identity keys stripped; no platform code path writes or reads it.';--> statement-breakpoint
COMMENT ON COLUMN "container"."options" IS 'Free-form jsonb accepted from `POST /containers` and `PATCH` with identity keys stripped; no platform code path writes or reads it.';--> statement-breakpoint
COMMENT ON COLUMN "container"."server_id" IS 'Observed placement: the server hosting this container (RESTRICT), distinct from the desired pin on `environment.server_id`.';--> statement-breakpoint
COMMENT ON COLUMN "container"."container_id" IS 'Docker container id from the daemon''s report; NULL between pre-allocation and the first report, and reset to NULL on an empty (stop/destroy) report.';--> statement-breakpoint
COMMENT ON COLUMN "container"."container_name" IS 'Docker `container_name`; `uuid` naming yields the service UUID plus `-N` per ordinal, `-in` for ingress, `-ha` for Orchestrator; `custom` keeps authored names.';--> statement-breakpoint
COMMENT ON COLUMN "container"."status" IS '`pending` until the daemon reports, then Docker''s compose ps State verbatim (`created` through `dead`), `unknown` for an unlisted state, `exited` on stop.';--> statement-breakpoint
COMMENT ON COLUMN "container"."role" IS '`service` for workload or engine replicas, `ingress` for the per-service Traefik or shared ProxySQL frontend (ordinal 1), `turbopanel` for the platform stack.';--> statement-breakpoint
COMMENT ON COLUMN "container"."compose_service_name" IS 'Compose service key the container was started under, as reported by the daemon; multi-instance clones carry a `-N` suffix on the base key.';--> statement-breakpoint
COMMENT ON COLUMN "container"."ordinal" IS '1-based instance index within the service, unique with `service_id` and `role`; ingress rows are always 1 and managed replicas match `replica.ordinal`.';--> statement-breakpoint
COMMENT ON TABLE "datacenter" IS 'Logical routing domain (not a building) of mutually routable private subnets, operator-created per org; a server may belong to zero or many via `ip` pins.';--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."metadata" IS 'Free-form jsonb returned by the datacenter API; no control-plane code path writes or interprets any key on it today.';--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."options" IS 'Operator policy jsonb: `priority` (0..1000, lower wins, default 100), `trusted` (default true), `addressPreference`, `sshPort`, `ntp`, timezone defaults.';--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."name" IS 'Operator-chosen display name; also seeded onto the site `network` row created together with the datacenter.';--> statement-breakpoint
COMMENT ON COLUMN "datacenter"."description" IS 'Optional operator free-text note about the datacenter.';--> statement-breakpoint
COMMENT ON TABLE "deployment" IS 'Current desired and applied state per (environment, server) pair, upserted on each redeploy by deploy-routes.ts; history lives in `environment.deploy` commands.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."metadata" IS 'Jsonb patched on apply outcome: `error` holds the last failure message and is reset to null on success.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."options" IS 'Per-target apply inputs written at deploy time: `secretPlan`, `siteReleases` (release trees the compose declares) and `phpModes` (mode per PHP site).';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."desired_generation" IS 'Environment deploy generation this row targets, written by deploy-routes.ts for every planned and drained server on each deploy.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."applied_generation" IS 'Generation the daemon last applied successfully on this server, set on the `applied` transition; NULL until a first success.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."desired_hash" IS 'sha256 of this server''s compiled runtime compose.yaml for the desired generation; NULL for draining targets.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."status" IS '`pending`, `applying` (deploy command created), `applied`, `failed`, or `draining` (server dropped from the plan, awaiting cleanup); set by deploy-routes.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."last_command_id" IS 'Id of the `command` row for the most recent apply attempt on this pair, set null when that command is pruned; the join key into the command history.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."finished_at" IS 'When the last apply attempt reached a terminal state; summarizes only the latest attempt.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."duration_ms" IS 'Wall-clock duration of the last apply attempt in milliseconds; NULL when unknown.';--> statement-breakpoint
COMMENT ON COLUMN "deployment"."outcome" IS 'Terminal outcome of the last apply attempt: `applied`, `failed` or `timed_out` (the command''s own terminal status); NULL until one finishes.';--> statement-breakpoint
COMMENT ON TABLE "dispatch" IS 'One-shot daemon execution payload for a command and the only place secret-bearing command input lives; inserted with its command row, deleted on success.';--> statement-breakpoint
COMMENT ON COLUMN "dispatch"."command_id" IS 'Primary key and FK to `command.id` (cascade): exactly one payload per command, written in the same transaction as the command row.';--> statement-breakpoint
COMMENT ON COLUMN "dispatch"."payload" IS 'Typed, bounded daemon command input (may carry compose YAML, credential envelopes or TLS material); read once by the consumer just before dispatch.';--> statement-breakpoint
COMMENT ON COLUMN "dispatch"."expires_at" IS 'Failure-retention deadline: NULL until a terminal failure, then now plus 24h (`failed`, `timed_out`, `cancelled`); the maintenance sweep deletes expired rows.';--> statement-breakpoint
COMMENT ON TABLE "edict" IS 'One firewall rule an operator typed, in the wire contract words; rules derived from what is deployed are computed per server and never stored here.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."organization_id" IS 'Owning organization; cascade-deletes the rule with the org.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."server_id" IS 'The one server the rule applies to; null means every server in the organization.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."label" IS 'Operator label shown in the console, also sent to the host as the rule''s comment, so it uses the comment alphabet.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."scope" IS '`host` for the host''s own listeners or `published` for a port Docker publishes for a container.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."action" IS '`accept` allows, `drop` blocks silently and `reject` blocks and tells the sender.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."proto" IS '`tcp`, `udp` or `any`; ports are meaningful only for `tcp` and `udp`.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."ports" IS 'One port or an inclusive ascending range such as `5432-5440`; null means every port, which only a block may say.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."source_kind" IS 'Who the rule is about: `any`, `servers` (the organization''s other servers), `datacenter`, `fabric` or `addresses`.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."source_addresses" IS 'Explicit addresses or CIDRs, one to 256 of them; only for `source_kind` `addresses`, empty for every other kind.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."is_enabled" IS 'False keeps the rule but leaves it out of the ruleset sent to hosts.';--> statement-breakpoint
COMMENT ON COLUMN "edict"."created_by" IS 'User who created the rule; null once that user is deleted.';--> statement-breakpoint
COMMENT ON TABLE "environment" IS 'One deployable copy of a project (staging, production) pinned to a server and deployed as a unit; created via the API or by the platform for system projects.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."metadata" IS 'Client jsonb; the promoted keys `serverId` and `component` are stripped on create and patch so placement and system identity never live here.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."options" IS 'Jsonb: `compose` overlay merged at deploy, plus deploy settings `deployStrategy`, `migrations`, `drainSeconds`, `healthTimeoutSeconds`, `rollbackWindowMinutes`.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."server_id" IS 'Desired whole-server placement pin and single source of truth; NULL inherits `project.options.defaultServerId` at deploy, lifecycle and stop.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."generation" IS 'Monotonic desired generation, incremented once per deploy plan by `bumpEnvironmentGeneration` and fanned into `deployment.desired_generation`.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."name" IS 'Scope folder name on every server, under `environment_name_check` (lowercase letters, digits, `_` and `-`, up to 32 chars, not reserved); unique per project.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."description" IS 'Optional free-text description written by the client API; the first environment is created with ''Default environment''.';--> statement-breakpoint
COMMENT ON TABLE "fabric" IS 'Org TurboFabric WireGuard mesh (host interface `tp0`), at most one row per organization; absence means TurboFabric is off and private keys are never stored.';--> statement-breakpoint
COMMENT ON COLUMN "fabric"."metadata" IS 'Free-form jsonb; no control-plane code path writes or reads it today.';--> statement-breakpoint
COMMENT ON COLUMN "fabric"."options" IS 'Mesh policy jsonb: `containerPool` (relay prefix pool, default `10.192.0.0/12`), `listenPort` (default 51821), `mtu` (1280..9000, default 1420), `allowRelay`.';--> statement-breakpoint
COMMENT ON COLUMN "fabric"."cidr" IS 'Host `tp0` address range that relay `address` values are carved from, auto-picked at enable to avoid every occupied org range (default `10.250.0.0/16`).';--> statement-breakpoint
COMMENT ON COLUMN "fabric"."name" IS 'Optional display name (1..255 chars of letters, digits, space, dot, underscore, dash); no control-plane code path writes it today.';--> statement-breakpoint
COMMENT ON TABLE "folder" IS 'One service or volume folder on one server, the record of what exists under a site owner scope; it locks environment, asset, project and organization naming.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."scope" IS 'Scope folder name exactly as created on the host: the environment name, or `common` for assets shared by every environment.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."kind" IS '`service` or `volume`; decides which of `service_id` and `storage_id` can be set.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."slug" IS 'Folder name of the asset, copied from its slug when the folder was planned.';--> statement-breakpoint
COMMENT ON COLUMN "folder"."state" IS '`planned` before the host has it, `present`, `removing` until the host confirms a delete, `orphan` found with no asset, `missing` gone from the host.';--> statement-breakpoint
COMMENT ON TABLE "forge" IS 'A registered Git provider application (GitHub App or GitLab OAuth app) that connections are granted through; `organization_id` NULL means instance-wide.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."organization_id" IS 'NULL means instance-wide (any organization may connect through it); set means the app belongs to that organization alone.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."provider" IS 'Git provider kind, `github` or `gitlab`, chosen at registration and never changed.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."name" IS 'Display name of the app; for GitHub Apps it is overwritten from the provider on each sync, and varchar(255) is that write''s only length guard.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."base_url" IS 'Origin the app lives on (github.com, gitlab.com or a self-managed host); part of the unique key with `provider` and `external_app_id`.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."api_url" IS 'Explicit API origin for a GitHub Enterprise Server or self-managed GitLab; NULL means derive it from `base_url`.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."external_app_id" IS 'Provider-side application id as text: the numeric GitHub App id (matches `X-GitHub-Hook-Installation-Target-ID`) or the GitLab OAuth application id.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."app_slug" IS 'GitHub App slug used to build the install URL; filled by the manifest flow or sync, NULL for GitLab.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."client_id" IS 'OAuth client id the provider issued for this app; its secret is sealed in `envelopes.clientSecretEnvelope`.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."redirect_uri" IS 'OAuth redirect URI registered with the provider for the GitLab authorize flow; NULL for GitHub Apps.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."webhook_origin" IS 'Public origin the provider was told to deliver webhooks to at registration; NULL on apps registered before that choice existed.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."is_public" IS 'Whether the provider was told the app is publicly installable; set at creation (true for instance-wide apps) and refreshed from GitHub on sync.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."custom_git_user" IS 'SSH user for clone URLs of a self-hosted forge on a non-standard port (`ssh://user@host:port/path`); unused by GitHub App sources.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."custom_git_port" IS 'SSH port for clone URLs of a self-hosted forge, paired with `custom_git_user`; unused by GitHub App sources.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."synced_at" IS 'Last successful reconcile of this row against the provider''s own record of the app (the sync handler); NULL if never synced.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."envelopes" IS 'Sealed `tpsecret` envelopes under JSON keys `privateKeyEnvelope`, `clientSecretEnvelope`, `webhookSecretEnvelope`; never returned by the API.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."webhook_ref" IS 'Opaque unguessable routing token that ends this app''s webhook URL (`/webhook/github/` plus the token); it routes a delivery to its app, not a credential.';--> statement-breakpoint
COMMENT ON COLUMN "forge"."webhook_token_hash" IS 'GitLab only: HMAC of the webhook token so a delivery on the unscoped path resolves in one indexed lookup; NULL for GitHub apps.';--> statement-breakpoint
COMMENT ON TABLE "connection" IS 'One Git provider grant to one organization, a GitHub App installation or a GitLab OAuth account connection, made through a `forge` row.';--> statement-breakpoint
COMMENT ON COLUMN "connection"."forge_id" IS 'Application the grant was made through; with `external_installation_id` it resolves a webhook delivery to exactly one row (cascades on forge delete).';--> statement-breakpoint
COMMENT ON COLUMN "connection"."provider" IS '`github` or `gitlab`, denormalized from the forge as a filter column.';--> statement-breakpoint
COMMENT ON COLUMN "connection"."external_installation_id" IS 'Provider-side id as text: the numeric GitHub App installation id, or the GitLab user/group id; for GitHub unique per forge across the instance.';--> statement-breakpoint
COMMENT ON COLUMN "connection"."account_login" IS 'Login of the provider account the grant sits on (GitHub installation account or GitLab user), refreshed on every connect or reconnect.';--> statement-breakpoint
COMMENT ON COLUMN "connection"."account_type" IS 'Provider account kind as GitHub reports it (`User` or `Organization`); always `User` for GitLab connections.';--> statement-breakpoint
COMMENT ON COLUMN "connection"."suspended_at" IS 'Set while the provider reports the installation suspended or a token refresh failed; cleared on reconnect, and suspended rows are skipped by the trigger.';--> statement-breakpoint
COMMENT ON COLUMN "connection"."oauth_envelope" IS 'GitLab only: sealed OAuth pair as JSON `accessTokenEnvelope`, `refreshTokenEnvelope`, `expiresAt`, `scope` (tpsecret strings); NULL for GitHub.';--> statement-breakpoint
COMMENT ON TABLE "permission" IS 'Allow-only ACL row: one positive grant of `permission` from a subject (`actor_type`, `actor_id`) on an entity; written by access routes, invitations, install.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."actor_type" IS 'Subject kind holding the grant: `user`, `team` or `organization` (`SUBJECT_TYPES` in `src/client/authz/catalog.ts`).';--> statement-breakpoint
COMMENT ON COLUMN "permission"."actor_id" IS 'Id of the subject row named by `actor_type` (a `user`, `team` or `organization` id); no FK because the referenced table varies.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."entity_type" IS 'Kind of the entity granted on: a resource-tree kind or `team` (`GRANT_ENTITY_TYPES`); `principal` and `repository` are deliberately excluded.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."entity_id" IS 'Id of the entity row named by `entity_type`; no FK because the referenced table varies, and ancestry is resolved from the domain tables at evaluation time.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."permission" IS 'Grantable permission key: `organization:own`, `organization:manage`, `team:own`, `team:manage`, `system:read` or `system:operate`; never `system:manage`.';--> statement-breakpoint
COMMENT ON TABLE "hosting" IS 'Routing entry for a service (hostnames or TCP/UDP ports, bind scope, TLS pin) rendered into Caddy and Traefik; written by the panel API or compose reconcile.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."metadata" IS 'Compose provenance markers `composeOwned`, `composeServiceName`, `composeRoute`, `composeTlsMode`, `composeAdopted` set by reconcile; other keys are client-set.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."options" IS 'Validated routing jsonb: `hostnames`, `pathPrefix`, `targetPort`, `protocol`, `ports`, `bind` (`public`, `datacenter`, `local`), `proxy` toggles, `web` hints.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."tls_id" IS 'Optional pin into the organization TLS library; NULL means Caddy `tls internal` (self-signed), and the pin is cleared when the certificate row is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."ip_id" IS 'Optional pin to a registered `ip` row of scope `public` for ingress addressing; requires `bind: public` and is cleared when the ip row is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."name" IS 'Display label: compose reconcile sets it to the hostname on compose-owned rows, otherwise the panel API writes it; no format CHECK, app-side length cap.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."description" IS 'Optional free-text description; panel-authored and preserved across compose reconcile.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."protocol" IS 'Mirror of validated `options.protocol` (`http`, `tcp`, `udp`) kept so SQL can filter ingress decisions without a jsonb cast; NULL reads as `http`.';--> statement-breakpoint
COMMENT ON COLUMN "hosting"."pending_at" IS 'When a waiting Let''s Encrypt request was made because DNS did not point here yet; NULL when none is waiting, and the sweep retries every row with a value.';--> statement-breakpoint
COMMENT ON TABLE "hostname" IS 'Uniqueness mirror of `hosting.options.hostnames`, one row per hostname, replaced on every hosting write so Postgres can enforce one hostname per organization.';--> statement-breakpoint
COMMENT ON COLUMN "hostname"."routing_organization_id" IS 'Organization whose routing owns the hostname, half of the unique key; today always the hosting''s own organization, named for future cross-organization hosting.';--> statement-breakpoint
COMMENT ON COLUMN "hostname"."hostname" IS 'One DNS name copied verbatim from `hosting.options.hostnames` by `replaceHostingHostnames`; unique per routing organization regardless of path prefix.';--> statement-breakpoint
COMMENT ON TABLE "origin" IS 'One control-plane public name operators publish, with its certificate source and any Let''s Encrypt attempt state.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."host" IS 'Normalized public URL entry (origin, host, or host:port) in the form public URL parsing already stores.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."source" IS 'Certificate source for this name: `platform-ca`, `uploaded`, or `lets-encrypt`.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."uploaded_cert_id" IS 'Uploaded pair (`certificate.id`) this name serves; required when `source` is `uploaded`, otherwise NULL.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."acme_last_attempt_at" IS 'When this instance last tried Let''s Encrypt for this name; NULL until an attempt runs.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."acme_last_error" IS 'Last Let''s Encrypt error for this name; NULL when the last attempt succeeded or none has run.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."not_after" IS 'Leaf expiry for this name when known; NULL for `platform-ca` and for Let''s Encrypt before a leaf exists.';--> statement-breakpoint
COMMENT ON TABLE "certificate" IS 'Uploaded control-plane certificate pair; several origin rows may reference one pair when its names cover them.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."label" IS 'Operator-chosen name for the uploaded pair, shown in the admin certificate list.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."cert_pem" IS 'Public certificate PEM, chain allowed; the leaf is parsed for names and expiry when the pair is stored.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."key_pem" IS 'Private key PEM sealed as a `tpsecret` envelope; the admin API never returns it.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."dns_names" IS 'JSON array of DNS names and IP addresses parsed from the leaf, used to test which hostnames the pair covers.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."not_after" IS 'Leaf expiry copied from the parsed certificate when the pair is stored.';--> statement-breakpoint
COMMENT ON TABLE "invitation" IS 'Team-scoped invite per (team, email) with a 7-day link; accept adds `teammate` and optional `grants` rows when stored.';--> statement-breakpoint
COMMENT ON COLUMN "invitation"."user_id" IS 'The inviter (a manager of the team), not the invitee; the invitee is known only by `email` until accept.';--> statement-breakpoint
COMMENT ON COLUMN "invitation"."team_id" IS 'Team the invitee joins on accept; there is no `organization_id`, the organization is derived through the team.';--> statement-breakpoint
COMMENT ON COLUMN "invitation"."expires_at" IS 'Creation time + 7 days; `status` is not flipped on expiry, readers compare this column against now.';--> statement-breakpoint
COMMENT ON COLUMN "invitation"."email" IS 'Invited address; accept succeeds only for a signed-in account whose email equals it case-insensitively.';--> statement-breakpoint
COMMENT ON COLUMN "invitation"."status" IS '`pending` at creation, then `accepted` by the accept route or `revoked` by the revoke route; expiry is not a status.';--> statement-breakpoint
COMMENT ON COLUMN "invitation"."grants" IS 'Optional grant specs (`entityType`, `entityId`, `permissionKey`) an owner attached; null means none; materialized on accept.';--> statement-breakpoint
COMMENT ON COLUMN "invitation"."token_hash" IS 'SHA-256 verifier of the secret emailed only in the accept link, used to look the invitation up; rotated on re-send, null on older invitations.';--> statement-breakpoint
COMMENT ON TABLE "ip" IS 'Single registry of every managed address per org, one row per address: public VPS addresses, datacenter free-pool rows and per-server membership pins.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."metadata" IS 'Pin markers written by the automatic repin pass: `repin` (`at`, `from` = previous address) and `stale` (`since`, `reason`) when no clear replacement exists.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."options" IS 'Free-form jsonb accepted on address create and echoed by the API; no control-plane code path interprets any key on it.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."datacenter_id" IS 'Datacenter this address belongs to; required when `scope = ''datacenter''`, null on public addresses; rows cascade away when the datacenter is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."network_id" IS 'Site subnet the address sits in; required on a membership pin (`scope = ''datacenter''` plus `server_id`), null on public and free-pool rows, set null on delete.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."server_id" IS 'Server holding this address; null marks a datacenter free-pool row, non-null together with `datacenter_id` makes a membership pin; server delete is restricted.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."address" IS 'IPv4 or IPv6 address (inet, unique per organization); the family is derived from it, not stored; immutable after create except via the automatic repin pass.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."allocation" IS 'Operator-chosen consumer model, `dedicated` (one consumer) or `shared`; immutable after create, and pins made by the datacenter routes are always `dedicated`.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."scope" IS 'Reachability class, `public` (world-reachable) or `datacenter` (inside one of the org''s site subnets, `datacenter_id` required); immutable after create.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."description" IS 'Optional operator note and the only editable field on an address; addresses are identified by `address`, never named.';--> statement-breakpoint
COMMENT ON COLUMN "ip"."repin_pending_fanout_at" IS 'Set by the automatic repin apply pass when a pin moved address, cleared by the maintenance sweep once the routing fan-out was enqueued; null = nothing pending.';--> statement-breakpoint
COMMENT ON TABLE "key" IS 'The Ed25519 daemon identity key of a server, one row per server (unique `server_id` and `fingerprint`), written on enroll and re-enroll by server-identity-db.';--> statement-breakpoint
COMMENT ON COLUMN "key"."server_id" IS 'Owning server, UNIQUE so re-enrolment replaces the row in place (fresh id, cleared `revoked_at`) unless the row is revoked; cascades on server delete.';--> statement-breakpoint
COMMENT ON COLUMN "key"."algorithm" IS 'Signature algorithm of the key, constrained to `Ed25519`.';--> statement-breakpoint
COMMENT ON COLUMN "key"."public_jwk" IS 'Raw Ed25519 public JWK with `crv`, `kty` and `x` as sent by the daemon at enrolment; the private half never leaves the host.';--> statement-breakpoint
COMMENT ON COLUMN "key"."fingerprint" IS 'SHA-256 hex digest of the canonical JSON of `crv`, `kty` and `x`; globally UNIQUE and used to look up the server on daemon auth.';--> statement-breakpoint
COMMENT ON COLUMN "key"."revoked_at" IS 'Set by `revokeDaemonKey`; non-null blocks new JWT issuance and is sticky, so a re-enrolment against a revoked row is refused rather than replacing it.';--> statement-breakpoint
COMMENT ON COLUMN "key"."last_used_at" IS 'Stamped by `touchDaemonKeyLastUsed` when a daemon JWT session is issued (single-column write, no cell wake); reset to NULL on re-enrolment.';--> statement-breakpoint
COMMENT ON TABLE "label" IS 'Key/value labels on a server, the source for compose `deploy.placement.constraints` (`node.labels.*`); replaced as a whole set by the labels API, max 64.';--> statement-breakpoint
COMMENT ON COLUMN "label"."key" IS 'Label key, 1 to 255 chars matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` and unique per server; matched by `node.labels.KEY` placement constraints.';--> statement-breakpoint
COMMENT ON COLUMN "label"."value" IS 'Label value string (empty allowed, default `''''`) capped at the description max length; compared with `==` or `!=` in placement constraints.';--> statement-breakpoint
COMMENT ON TABLE "leaf" IS 'Tracking row per deployed Organization-CA-signed leaf (`ingress` per server, `engine` per replica); upserted after apply succeeds, keeps no history.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."server_id" IS 'Host the leaf is deployed on; unique per server for `ingress` rows.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."kind" IS '`ingress` (ProxySQL frontend leaf on a server) or `engine` (a cluster replica''s engine leaf).';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."managed_id" IS 'Engine leaves only: the managed cluster that owns the replica; must be null on `ingress` rows.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."replica_id" IS 'Engine leaves only: the replica whose leaf this tracks, unique per replica; must be null on `ingress` rows.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."ca_id" IS 'The `tls` Organization CA row that signed the leaf; the row is cascade-deleted with that CA.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."ca_generation" IS 'Generation of the signing CA at issue time; a mismatch with the active generation makes the leaf due for renewal.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."not_after" IS 'Leaf expiry (90-day lifetime); the renewal sweep treats a leaf as due when less than a third of its lifetime remains.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."issued_at" IS 'When the leaf was minted; refreshed on every re-issue upsert.';--> statement-breakpoint
COMMENT ON TABLE "lease" IS 'Cross-isolate compare-and-swap lease: one row per `name` (plus organization for the billing lock) with an `owner` token and `expires_at`; four callers share it.';--> statement-breakpoint
COMMENT ON COLUMN "lease"."name" IS 'Lease name: `OFFLINE_SWEEP_LOCK`, `LEAF_RENEWAL_SWEEP_LOCK` and `REENCRYPT_SWEEP_LOCK` are global, `BILLING_QUANTITY_LOCK` is per organization.';--> statement-breakpoint
COMMENT ON COLUMN "lease"."organization_id" IS 'Null for the three global leases, set for the per-organization `BILLING_QUANTITY_LOCK`; unique with `name` under NULLS NOT DISTINCT so one global row per name.';--> statement-breakpoint
COMMENT ON COLUMN "lease"."owner" IS 'Random UUID minted by the holder and checked on every steal or release; empty string plus expired `expires_at` is a release tombstone (offline, leaf).';--> statement-breakpoint
COMMENT ON COLUMN "lease"."expires_at" IS 'Moment the hold lapses and the row becomes stealable (TTL 60 s billing, 90 s offline sweep, 120 s leaf renewal and reencrypt); extended or reset by the holder.';--> statement-breakpoint
COMMENT ON COLUMN "lease"."cursor" IS 'Keyset resume point (`notAfter`, `id`) written only by the leaf-renewal sweep and compared on every steal with `owner` and `expires_at`; null elsewhere.';--> statement-breakpoint
COMMENT ON TABLE "license" IS 'Organization-scoped server registration key: one row per minted key, latched to one server on first enroll, soft-deleted via `revoked_at`, never tied to a tier.';--> statement-breakpoint
COMMENT ON COLUMN "license"."server_id" IS 'Server that consumed this key, set once on first successful enroll (partial unique index: one license per server); null while unconsumed, SET NULL on delete.';--> statement-breakpoint
COMMENT ON COLUMN "license"."name" IS 'Optional operator display name; `this server` is reserved for the colocated control-plane license minted at install and refused by `POST /licenses`.';--> statement-breakpoint
COMMENT ON COLUMN "license"."token" IS 'Argon2id PHC hash of the registration key (same format as `account.password`); the plaintext is returned once at mint and cannot be recovered from this row.';--> statement-breakpoint
COMMENT ON COLUMN "license"."revoked_at" IS 'Soft-delete timestamp set by a revoke or by an ended subscription revoking every license; non-null means inactive, and the row keeps `server_id` for audit.';--> statement-breakpoint
COMMENT ON TABLE "login" IS 'One engine role on one managed cluster; not a principal, which is only a site owner Linux user; written by the managed users API.';--> statement-breakpoint
COMMENT ON COLUMN "login"."principal_id" IS 'Site owner Linux user the login shares its name with, cascade-deleted with it; NULL for a login made on its own and for the root and replication logins.';--> statement-breakpoint
COMMENT ON COLUMN "login"."role" IS '`root` for the cluster admin login, `replication` for the member-to-member login, `user` for an operator-created login.';--> statement-breakpoint
COMMENT ON COLUMN "login"."username" IS 'Name the customer typed; equals `applied_username` for `plain` names and for the root and replication logins.';--> statement-breakpoint
COMMENT ON COLUMN "login"."applied_username" IS 'Engine role name created on the cluster; unique per cluster after trim and case-fold, and equal to the principal name when `principal_id` is set.';--> statement-breakpoint
COMMENT ON COLUMN "login"."name_scheme" IS 'How `applied_username` was derived from `username`: `plain` (same), `partial` (plus a random suffix) or `random` (no trace of it).';--> statement-breakpoint
COMMENT ON COLUMN "login"."password" IS 'Write-only credential sealed as a `tpsecret` envelope, never returned on GET and resealed to `tpdaemon` for delivery.';--> statement-breakpoint
COMMENT ON COLUMN "login"."grant_mode" IS 'Who sets the permissions on reconcile: `preset` (logins from before modes), `recipe` (the panel) or `self` (the owner by hand, never reset).';--> statement-breakpoint
COMMENT ON COLUMN "login"."is_tool" IS 'True for a database-tool login: the daemon sends all of its traffic to the primary and adds no read/write split rules (API field `tool`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."allowed_sources" IS 'Places the login may connect from (`internal`, `server:` plus an id, `address:` plus a value); NULL means anywhere (API field `allowedSources`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."max_connections" IS 'Per-login cap on open connections, at least 1; NULL means no cap (API field `maxConnections`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."access" IS 'Routing: `read-write` sends the login to the primary, `read-only` to read replicas or the primary when there are none (API field `connectionRole`).';--> statement-breakpoint
COMMENT ON COLUMN "login"."privileges" IS 'What the login may do in each database it can use: `owner`, `read-write`, `read-only` or `admin`; empty for the root and replication logins.';--> statement-breakpoint
COMMENT ON TABLE "managed" IS 'One managed database cluster per environment (1:1 via unique environment_id); created by the managed create route, status projected by the command consumer.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."metadata" IS 'Residual cluster facts: `rootLoginId` and `rootUsername` set at create, plus `host`, `port` and `error` written by the command consumer from daemon results.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."options" IS 'Operator settings jsonb with the key `settings` (engine ManagedSettings), written by the managed routes; the databases are `database` rows.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."environment_id" IS 'Owning environment; exactly one managed row per environment (unique index), cascade-deleted with it.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."server_id" IS 'Placement pin of the primary member''s host, copied from the environment at create and re-set by the consumer only on a primary-member apply success.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."name" IS 'Operator label for the cluster (1-255 chars of letters, digits, space, dot, underscore, hyphen); null when unnamed.';--> statement-breakpoint
COMMENT ON COLUMN "managed"."engine" IS 'Catalog engine code set once at create from ManagedEngineSpec: `postgres`, `mysql`, `mariadb`, `redis` or `clickhouse` (only the first three are creatable).';--> statement-breakpoint
COMMENT ON COLUMN "managed"."status" IS 'Lifecycle state: `provisioning` at create, `applying` while a command is queued, then daemon-observed `ready`, `stopped` or `failed` projected by the consumer.';--> statement-breakpoint
COMMENT ON TABLE "database" IS 'One database inside a managed cluster: its name, whether it has an owner role and the login chosen as its owner; written by the managed databases API.';--> statement-breakpoint
COMMENT ON COLUMN "database"."name" IS 'Name on the engine as typed (1-255 chars); unique per cluster after case-fold.';--> statement-breakpoint
COMMENT ON COLUMN "database"."is_role_owned" IS 'Postgres only: true when the database is owned by an owner role (`tp_NAME_owner`, `_rw`, `_ro`).';--> statement-breakpoint
COMMENT ON COLUMN "database"."owner_login_id" IS 'Postgres only: the login the customer chose as owner; NULL means the default no-login owner role. Cleared when that login is deleted.';--> statement-breakpoint
COMMENT ON TABLE "marker" IS 'Join edge applying one tag to exactly one taggable entity; org is derived through `tag`, and `setEntityTags` replaces an entity''s whole set.';--> statement-breakpoint
COMMENT ON COLUMN "marker"."server_id" IS 'Tagged server when the parent is a server; exactly one of the seven parent columns is non-NULL (CHECK), unique per tag, cascades on delete.';--> statement-breakpoint
COMMENT ON COLUMN "marker"."workspace_id" IS 'Tagged workspace when the parent is a workspace; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.';--> statement-breakpoint
COMMENT ON COLUMN "marker"."project_id" IS 'Tagged project when the parent is a project; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.';--> statement-breakpoint
COMMENT ON COLUMN "marker"."environment_id" IS 'Tagged environment when the parent is an environment; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.';--> statement-breakpoint
COMMENT ON COLUMN "marker"."service_id" IS 'Tagged service when the parent is a service; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.';--> statement-breakpoint
COMMENT ON COLUMN "marker"."datacenter_id" IS 'Tagged datacenter when the parent is a datacenter; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.';--> statement-breakpoint
COMMENT ON COLUMN "marker"."storage_id" IS 'Tagged storage when the parent is a storage; exactly one of the seven parent columns is non-NULL, unique per tag, cascades on delete.';--> statement-breakpoint
COMMENT ON TABLE "monitor" IS 'Per-server ProxySQL backend monitor credential minted by the control plane, one row per server; kept off `server.options` since that jsonb is served and cached.';--> statement-breakpoint
COMMENT ON COLUMN "monitor"."server_id" IS 'Owning server, UNIQUE because one ProxySQL runs per host with a single global monitor credential; ON DELETE CASCADE so a deleted host leaves no orphaned secret.';--> statement-breakpoint
COMMENT ON COLUMN "monitor"."username" IS 'Deterministic monitor role name: `tp_monitor_` plus the first 12 hex chars of the server UUID without dashes, kept within engine identifier limits.';--> statement-breakpoint
COMMENT ON COLUMN "monitor"."secret_envelope" IS 'Password sealed with the data-encryption key (`ENVELOPE_PREFIX_SECRET` prefix); resealed to a `tpdaemon` envelope per recipient at send time.';--> statement-breakpoint
COMMENT ON TABLE "mount" IS 'Attachment of a storage identity inside one compose service at a container path; unique (service_id, destination_path), written by the storage API and compose.';--> statement-breakpoint
COMMENT ON COLUMN "mount"."metadata" IS 'Free-form jsonb settable through the mount API; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "mount"."options" IS 'Reserved jsonb; no current code path writes it.';--> statement-breakpoint
COMMENT ON COLUMN "mount"."service_id" IS 'Consuming compose service; ON DELETE RESTRICT, so compose unregister clears mounts in the same transaction as the service reconcile.';--> statement-breakpoint
COMMENT ON COLUMN "mount"."destination_path" IS 'Container path the storage is mounted at, unique per service.';--> statement-breakpoint
COMMENT ON COLUMN "mount"."subpath" IS 'Optional subdirectory of the storage to mount instead of its root; forwarded to the daemon when non-empty.';--> statement-breakpoint
COMMENT ON COLUMN "mount"."is_read_only" IS 'Mount the storage read-only in the container (API field `readOnly`); default false.';--> statement-breakpoint
COMMENT ON TABLE "network" IS 'Org-owned network registry row of `kind` datacenter, docker, compose, managed or reserved; which scope FKs and `cidr` may be set is fixed per kind by a CHECK.';--> statement-breakpoint
COMMENT ON COLUMN "network"."metadata" IS 'Free-form client jsonb that the networks API accepts; also read as a legacy fallback for `metadata.dockerNetworkName` when `options` lacks it.';--> statement-breakpoint
COMMENT ON COLUMN "network"."options" IS 'Kind-specific jsonb: `dockerNetworkName` plus optional `subnet`, `ipRange`, `gateway`, `mtu` on docker rows; `dockerNetworkName` (row UUID) on compose/managed.';--> statement-breakpoint
COMMENT ON COLUMN "network"."datacenter_id" IS 'Owning datacenter, required and only allowed on `kind = ''datacenter''` site CIDR rows (a datacenter may own several); datacenter delete is restricted meanwhile.';--> statement-breakpoint
COMMENT ON COLUMN "network"."server_id" IS 'Optional host pin allowed only on `kind = ''docker''` external Docker registrations (null = org-wide); every other kind must leave it null.';--> statement-breakpoint
COMMENT ON COLUMN "network"."environment_id" IS 'Optional environment pin for `kind = ''compose''` spanning networks (null = org-shared); set null when the environment is deleted so the row survives.';--> statement-breakpoint
COMMENT ON COLUMN "network"."kind" IS 'Row kind: `datacenter` (site CIDR), `docker` (external Docker network), `compose` (TurboFabric spanning network), `managed` (one per org) or `reserved`.';--> statement-breakpoint
COMMENT ON COLUMN "network"."cidr" IS 'Registered range: required on `datacenter` and `reserved` rows, mirrored from `options.subnet` on `docker` rows, null on `managed`; checked for collisions.';--> statement-breakpoint
COMMENT ON COLUMN "network"."name" IS 'Display name; operator-set on docker and reserved rows, seeded from the datacenter name on site rows, and the Compose network key on compose rows.';--> statement-breakpoint
COMMENT ON COLUMN "network"."compose_key" IS 'Compose network key from the environment''s document on `kind = ''compose''` rows (unique per environment), written by `ensureComposeNetworkRow`; null otherwise.';--> statement-breakpoint
COMMENT ON TABLE "notification" IS 'One bell inbox row per event per recipient user, written by `emitNotification` for every member or manager the event''s audience names.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."user_id" IS 'Recipient of the inbox row; one row per person the event reached, chosen by the event''s audience (members or managers).';--> statement-breakpoint
COMMENT ON COLUMN "notification"."organization_id" IS 'Organization the event belongs to; NULL for an instance-scoped event such as `fleet.mass_disconnect`.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."event" IS 'Catalogue code (`NOTIFICATION_EVENTS`): `server.offline`, `fleet.mass_disconnect`, `server.deleted`, `server.daemon_key_revoked`, `access.grant_*`.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."severity" IS '`info`, `warning` or `critical`, copied from the event''s catalogue definition.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."title" IS 'One-line sentence rendered from the catalogue''s title template at emit time; also the email subject.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."body" IS 'Fuller sentence rendered from the catalogue''s body template; NULL when the event defines none.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."target_type" IS 'Catalog entity kind the event is about (`server`, or a grant''s entity type) so the bell can link to it; NULL when there is no target.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."target_id" IS 'UUID of the `target_type` entity; not a foreign key, so it may outlive the entity.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."context" IS 'Small non-secret facts the sentence was rendered from, such as `serverName`, `lastSeenAt`, `count`, `actorEmail`, `permissionKey`, `subjectKind`, `subjectId`.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."read_at" IS 'When the recipient marked it read (Mark all read); NULL while unread and counted in the badge.';--> statement-breakpoint
COMMENT ON COLUMN "notification"."dismissed_at" IS 'When the recipient dismissed the row from the bell; NULL while it is still shown.';--> statement-breakpoint
COMMENT ON TABLE "channel" IS 'An address notifications can be delivered to, owned by the instance, one organization or one user per `scope`; addresses of secret kinds are sealed.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."scope" IS 'Owner kind: `instance`, `organization` or `user`; the owner columns must agree with it (CHECK).';--> statement-breakpoint
COMMENT ON COLUMN "channel"."organization_id" IS 'Owning organization, set only when `scope` is `organization` and NULL otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."user_id" IS 'Owning user, set only when `scope` is `user`; a personal channel follows the user across organizations.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."kind" IS 'Transport: `email`, `webhook`, `slack`, `discord`, `telegram` or `push` (push is registered by the store apps, never typed).';--> statement-breakpoint
COMMENT ON COLUMN "channel"."label" IS 'Owner-chosen display name such as ''Ops Slack''.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."address" IS 'Delivery address: plain for `email`, else a sealed `tpsecret` envelope (webhook, Slack or Discord URL, Telegram `token/chatId`, push token).';--> statement-breakpoint
COMMENT ON COLUMN "channel"."signing_secret" IS 'Sealed `tpsecret` HMAC key for the generic `webhook` kind (`X-TurboPanel-Signature: sha256=...`); NULL for other kinds.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."verified_at" IS 'When the address was confirmed; stamped at creation for own or member emails, NULL means unverified and email delivery is skipped.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."disabled_at" IS 'Set when the owner pauses the channel; it keeps its rules but receives nothing until resumed.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."created_by_user_id" IS 'User whose session created the channel (provenance, set NULL on user delete); differs from `user_id` for org and instance channels.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."digest_cadence" IS 'Email only: `hourly` or `daily` batches non-urgent events into one summary per window; NULL sends each event as it happens.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."quiet_start_minute" IS 'Quiet hours start as minutes after local midnight (0-1439), set together with `quiet_end_minute`; NULL means no quiet hours.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."quiet_end_minute" IS 'Quiet hours end as minutes after local midnight (0-1439); the window may wrap midnight, and held events go out as one summary when it ends.';--> statement-breakpoint
COMMENT ON TABLE "attempt" IS 'Delivery-attempt ledger: one row per event per routed channel, inserted before the send so a crash leaves a pending row; retried by the maintenance tick.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."organization_id" IS 'Organization the event belongs to; NULL for an instance-scoped event.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."event" IS 'Catalogue code (`NOTIFICATION_EVENTS`), same vocabulary as `notification.event`.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."severity" IS '`info`, `warning` or `critical`, copied from the event''s catalogue definition.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."payload" IS 'Rendered non-secret message as JSON: `event`, `severity`, `title`, `body`, `organizationId`, `organizationName`, `targetType`, `targetId`, `context`, `at`.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."status" IS '`pending` (default), `sent`, `failed` (retry due), `abandoned` (after 5 attempts) or `held` (waits for quiet hours or a digest); retries skip `held`.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."attempts" IS 'Number of send attempts so far, bumped in SQL by the sender; the row is abandoned once it reaches 5.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."next_attempt_at" IS 'Earliest time the retry sweep may pick the row up: now plus 2 min grace on insert, then backoff of 1, 5, 25 and 125 min; NULL once sent.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."sent_at" IS 'When a send succeeded; NULL until then.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."last_error" IS 'Short failure code from the last attempt (`http_503`, `timeout`, `network`, `address_scheme_not_https`), never a body or the address.';--> statement-breakpoint
COMMENT ON TABLE "rule" IS 'Subscription row saying which event (or `*`) reaches a channel at or above a severity floor; a channel with no rule receives nothing.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."event" IS 'One catalogue event code, or `*` for every event; unique per channel.';--> statement-breakpoint
COMMENT ON COLUMN "rule"."min_severity" IS 'Severity floor `info` (default), `warning` or `critical`; delivered only when the event''s severity ranks at or above it.';--> statement-breakpoint
COMMENT ON TABLE "organization" IS 'Tenant organization; one is created by the install wizard and by every sign-up, its members come through teams, and `options` holds org-wide defaults.';--> statement-breakpoint
COMMENT ON COLUMN "organization"."options" IS 'Org-wide settings merged key-by-key by the organization routes (`defaultServerTimezone`, `maxServers`, `acmeEnabled`, `managedDatabase`, `phpModes` and more).';--> statement-breakpoint
COMMENT ON COLUMN "organization"."name" IS 'Display name; sign-up uses `you@example.com''s organization` from email, else `My Organization` if missing, blank, or label invalid; install Root Organization.';--> statement-breakpoint
COMMENT ON TABLE "passkey" IS 'One WebAuthn credential registered by a user (several per user allowed), unique by `credential_id`; inserted at registration, updated on each passkey sign-in.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."aaguid" IS 'Authenticator model AAGUID decoded from the attestation as a dashed lowercase UUID string; identifies the make, not the individual key.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."name" IS 'User-chosen label given at registration (the device or authenticator it lives on); shown in the Security screen, never used for matching.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."public_key" IS 'Credential public key as a JSON-serialised JWK (ES256 or RS256) converted from the attestation''s COSE key; verifies sign-in assertions.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."credential_id" IS 'Base64url credential id from the attestation; unique across the instance and the lookup key for passkey sign-in.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."counter" IS 'Authenticator signature counter from the last accepted assertion; a lower value rejects the sign-in (clone detection) and updates are compare-and-swap.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."device_type" IS '`multiDevice` when the attestation flags the credential backup-eligible, else `singleDevice`; derived once at registration.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."is_backed_up" IS 'Backup-state flag from the attestation (credential synced by its provider); with `device_type` it drives the Synced / Multi-device / This device label.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."transports" IS 'JSON array string of WebAuthn transports reported at registration (for example `internal`, `usb`, `hybrid`), or null when none were reported.';--> statement-breakpoint
COMMENT ON TABLE "payer" IS 'Projection of one provider customer (who pays), written only by the Stripe webhook ingress; its subject is exactly one of an organization or a user.';--> statement-breakpoint
COMMENT ON COLUMN "payer"."organization_id" IS 'Organization subject; exactly one of `organization_id` and `user_id` is non-null (`payer_subject_check`), and it is unique per provider when set.';--> statement-breakpoint
COMMENT ON COLUMN "payer"."user_id" IS 'User subject for a personal subscription; exactly one of `organization_id` and `user_id` is non-null (`payer_subject_check`), unique per provider when set.';--> statement-breakpoint
COMMENT ON COLUMN "payer"."provider" IS 'Payment provider that owns this customer; only `stripe` is allowed today (CHECK `payer_provider_check`), `apple` is reserved in comments but not accepted.';--> statement-breakpoint
COMMENT ON COLUMN "payer"."provider_customer_id" IS 'Provider-side customer id (Stripe `cus_...`); unique together with `provider` and the conflict target of the webhook upsert.';--> statement-breakpoint
COMMENT ON COLUMN "payer"."tax_id" IS 'Value of the first tax id the provider reports on the customer (`customer.tax_ids`), copied by the webhook for display; presence only, never validated here.';--> statement-breakpoint
COMMENT ON TABLE "principal" IS 'A site owner Linux user: the host account that runs sites and owns their tree; written by the principals API and the compose deploy.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."metadata" IS 'Holds `home` (under `/srv/users`), an optional `uid`/`gid` mirror and `composeAlias`.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."options" IS 'Host-account settings: `shell` (closed allowlist, default `/usr/sbin/nologin`) and optional operator `uid`/`gid` override; parsed by `parsePrincipalOptions`.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."username" IS 'Short internal account name (letter or underscore first, then letters, digits, underscore, hyphen); server accounts get a shorter API-layer cap.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."applied_username" IS 'Login actually created on the host or engine: `username`, or `username` plus an underscore and 11 random chars when the org randomizes names; fixed at create.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."password" IS 'Write-only credential sealed as a `tpsecret` envelope, never returned on GET and resealed to `tpdaemon` for delivery; null when no engine password exists.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."organization_id" IS 'Home organization set on every insert, not derived.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."project_id" IS 'Optional project scope for compose-declared hosting principals; set to NULL when the project is deleted, the principal stays.';--> statement-breakpoint
COMMENT ON TABLE "placement" IS 'One system principal on one server, the per-server form of a `principal` row; written by deploy fan-out, teardown and server removal.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."state" IS '`pending` when a deploy that creates the account is queued, `present` once it succeeded, `retiring` once a stop that retires it is queued, `absent` after.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."uid" IS 'Linux uid the host assigned, reported by the daemon; NULL until then, unique per server when set.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."gid" IS 'Linux gid the host assigned, reported by the daemon; NULL until then.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."home" IS 'Account home on the host, `/srv/users/` plus the applied username, copied from the deploy material.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."source" IS 'Why the account is on this server: `compose` (an `x-turbopanel.principals` alias), `manual` (a project principal), or `storage` (a storage entry owner).';--> statement-breakpoint
COMMENT ON TABLE "project" IS 'One application or stack described by one compose document, owned by a workspace; user projects come from the API, system projects from the platform hierarchy.';--> statement-breakpoint
COMMENT ON COLUMN "project"."metadata" IS 'Client jsonb: `type` is `docker-compose`, `managed`, `template` or platform-only `system` (absent means setup not chosen yet), plus optional catalog `code`.';--> statement-breakpoint
COMMENT ON COLUMN "project"."options" IS 'Jsonb: `compose`, `containerNaming`, `defaultServerId`, `composeSource`, and deploy defaults `drainSeconds`, `healthTimeoutSeconds`, `rollbackWindowMinutes`.';--> statement-breakpoint
COMMENT ON COLUMN "project"."organization_id" IS 'Denormalized copy of the workspace''s organization, resolved on every insert; exists so `uniq_project_organization_name` can be a real per-organization unique.';--> statement-breakpoint
COMMENT ON COLUMN "project"."repository_id" IS 'The single Git repository this project is; NULL when not repository-backed, adopted from the first compose `sourceId` on save, RESTRICT on delete.';--> statement-breakpoint
COMMENT ON COLUMN "project"."name" IS 'Display label, unique per organization after trim and case-fold (partial unique index, 409 `project_name_in_use`); four system project names are reserved.';--> statement-breakpoint
COMMENT ON COLUMN "project"."description" IS 'Optional free-text description written by the client API; no format CHECK, app-side length cap only.';--> statement-breakpoint
COMMENT ON COLUMN "project"."component" IS 'System-component discriminator (`hosting-ingress`, `managed-ingress`, `managed-ha`, `turbopanel`) written by the platform hierarchy; NULL on every user project.';--> statement-breakpoint
COMMENT ON COLUMN "project"."slug" IS 'Short name taken from the project name, unique per organization and never part of a path; editable until any folder exists under the project, then locked.';--> statement-breakpoint
COMMENT ON COLUMN "project"."default_server_id" IS 'Default placement server: an environment with no `server_id` of its own inherits it; set null when the server is deleted (API field `options.defaultServerId`).';--> statement-breakpoint
COMMENT ON TABLE "recovery" IS 'Durable HA journal entry for one managed cluster recovery (failover, switchover or DR); at most one non-terminal row per managed_id, written by the HA flow.';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."metadata" IS 'Fencing and progress facts: `fencingEpoch`, `fenceCommandIds`, `promoteCommandId`, `haPresent`, `fenced`, `drainApplied`, `lagBytes`, `blockedReason`.';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."kind" IS '`automatic-failover`, `switchover` (planned promotion of a failover replica) or `disaster-recovery` (promotion of a remote read replica).';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."source_primary_member_id" IS '`replica.id` of the primary being replaced, stored without an FK on purpose so the journal outlives the member.';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."target_member_id" IS '`replica.id` of the member being promoted, set null if that member is removed; null when an automatic failover was `blocked` with no eligible candidate.';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."state" IS 'Journal phase: `detecting`, `fencing`, `promoting`, `repointing`, `reconciling-ingress`, `verifying`, then terminal `completed`, `failed` or `blocked`.';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."started_at" IS 'When the recovery was opened; set explicitly by `insertRecovery` together with the initial state.';--> statement-breakpoint
COMMENT ON COLUMN "recovery"."completed_at" IS 'When the recovery reached a terminal state; null while still in flight.';--> statement-breakpoint
COMMENT ON TABLE "relay" IS 'One server''s membership in an org TurboFabric mesh (one row per fabric and server), allocated by `ensureFabricRelays`; holds its `tp0` address and peer config.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."metadata" IS 'Control-plane reconcile stamps: `appliedPayloadHash`, `appliedAt`, `observed` (peers the daemon saw) and diagnostics-only `paths` (selected path per peer).';--> statement-breakpoint
COMMENT ON COLUMN "relay"."options" IS 'Relay policy jsonb merged by PATCH: `allowRelay` (true or false, null inherits the org and may only tighten) and `preferredGatewayIds` (ordered, deduped).';--> statement-breakpoint
COMMENT ON COLUMN "relay"."server_id" IS 'Member server, unique per fabric; delete is restricted, so `deleteServerFabricMembership` must remove the relay and its subnets first.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."address" IS 'Allocated `tp0` host address (inet) carved from `fabric.cidr`, unique per fabric and rendered as a /32 host route in peer AllowedIPs.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."role" IS 'Mesh role, `gateway` (advertises `advertised_cidrs` to remote peers, must belong to a datacenter with a subnet) or `member` (host route only, the default).';--> statement-breakpoint
COMMENT ON COLUMN "relay"."keepalive" IS 'Operator WireGuard PersistentKeepalive in seconds (1..65535); null means auto, which is 25 s on `direct_nat` paths and none otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."endpoint_address" IS 'Operator endpoint override (inet, no port); null means the path planner derives the endpoint from datacenter, public and daemon-reported addresses.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."public_key" IS 'Server''s WireGuard public key, stamped by the control plane from the first successful `server.fabric.reconcile` result; null until then, unique per fabric.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."prefix" IS 'Container aggregate CIDR (a /16 from `fabric.options.containerPool`) allocated to this server and forwarded over `tp0`; per-network subnets are carved from it.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."advertised_cidrs" IS 'Operator-configured LAN CIDRs a `gateway` relay advertises to remote peers (native cidr[], host bits cleared); must be empty when `role = ''member''`.';--> statement-breakpoint
COMMENT ON COLUMN "relay"."preshared_key" IS 'Sealed `tpsecret` envelope of the operator-set WireGuard preshared key; write-only, never returned by the API, resealed for the daemon at reconcile.';--> statement-breakpoint
COMMENT ON TABLE "replica" IS 'One server''s membership in a managed cluster (primary plus replicas); exactly one `primary` per managed_id, written by the member lifecycle and the consumer.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."metadata" IS 'Daemon-observed `replication` health (`state`, `observedAt`, optional `lagBytes`, `lagSeconds`) written by the consumer after apply and lifecycle commands.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."server_id" IS 'Host running this member; one member per server per cluster and a private port is unique per server; deleting the server is restricted.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."role" IS '`primary` or `replica`; a partial unique index allows one primary per cluster and the consumer swaps roles on promote and failover.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."replica_class" IS '`failover` (same datacenter, promotable) or `read` (any org server, never auto-promoted); null on the primary and ignored when role is primary.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."is_read_eligible" IS 'Whether the listener may route read-only logins to this member; true on the primary, operator-chosen on replicas (API field `readEligible`).';--> statement-breakpoint
COMMENT ON COLUMN "replica"."ordinal" IS '1-based member ordinal, unique per cluster; the primary is 1 and it mirrors the engine service''s container ordinal.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."replication_transport" IS 'Resolved private path from this member to the primary: `local`, `datacenter`, `fabric` or `public`; null until resolved or on the primary.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."private_port" IS 'Host port 45000-45999 published on the member''s private address for replication and ProxySQL backends; allocated per server, null for single-member clusters.';--> statement-breakpoint
COMMENT ON COLUMN "replica"."status" IS 'Per-member state: `provisioning`, `applying`, `ready`, `stopped`, `failed` or `needs_resync` (set on demote or a failed fence, never auto-cleared).';--> statement-breakpoint
COMMENT ON TABLE "repository" IS 'One Git repository registered to an organization (one row per repo per org); workloads attach via `project.repository_id` or compose `x-turbopanel.source` refs.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."metadata" IS 'Free-form jsonb the caller may send on repository create or patch; bookkeeping, never load-bearing, and the API folds the inspect columns into it on the wire.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."options" IS 'Caller-supplied policy jsonb; the webhook trigger also parks `pendingChecks` (`commitSha`, `ref`, `recordedAt`) here in `checks_passed` mode.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."connection_id" IS 'Provider connection that authorizes clones and webhook matching; NULL for deploy-key and anonymous git lanes, set NULL when the connection is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."secret_id" IS 'Deploy key (`secret` row with the sealed private key) for SSH and deploy-key GitLab sources; NULL for connection-backed or anonymous repositories.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."provider" IS '`github`, `gitlab`, or `git` for a plain URL read through a connected server instead of a provider API.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."repository_url" IS 'Clone URL stored canonicalized (lower-cased host, `.git` suffix, no trailing slash) so the per-organization unique dedupes spellings.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."repository_external_id" IS 'Provider-side repository/project id as text, used to match webhook deliveries because it survives renames; NULL for plain git.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."default_branch" IS 'Tracked branch: operator-set, or copied from `detected_default_branch` while the row still follows the provider''s default.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."subdirectory" IS 'Relative checkout subdirectory used as the build root, same rule as compose `x-turbopanel.root`; NULL means the repository root.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."auto_deploy" IS 'Push-to-deploy mode: `immediate`, `checks_passed` (wait for a green check suite) or `disabled` (default); plain git never deploys on push.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."detected_default_branch" IS 'Provider-reported default branch from the latest refresh or inspect, compared with `default_branch` to show drift.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."default_branch_checked_at" IS 'When `detected_default_branch` was last read from the provider.';--> statement-breakpoint
COMMENT ON COLUMN "repository"."last_inspected_at" IS 'When the head commit was last inspected through the provider (the inspect route''s bookkeeping).';--> statement-breakpoint
COMMENT ON COLUMN "repository"."last_inspected_commit_sha" IS 'Head commit SHA observed at `last_inspected_at`.';--> statement-breakpoint
COMMENT ON TABLE "retention" IS 'A scheduled backup of one managed engine or one local storage copy, pushed to its host as a systemd timer that runs without the control plane.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."organization_id" IS 'Owning organization stored directly, because the target is polymorphic; cascade-deletes the policy with the org.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."target_kind" IS '`managed` or `copy`: which of `managed_id` and `copy_id` names the target; exactly one is set (`retention_target_check`).';--> statement-breakpoint
COMMENT ON COLUMN "retention"."name" IS 'Operator label for the policy, shown in the console''s backup list.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."schedule" IS 'The schedule as authored, a cron expression or alias; translated to a systemd `OnCalendar` value when pushed to the host.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."timezone" IS 'IANA zone the schedule is read in; null means the host''s local time.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."retention_keep" IS 'How many of this policy''s own artifacts the host keeps, 1 to 100; older ones are pruned after each run.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."is_enabled" IS 'False pauses the policy: its timer is removed from the host while the row and its run history stay.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."next_run_at" IS 'When the host''s timer next fires, as last reported by the daemon; null until a report arrives.';--> statement-breakpoint
COMMENT ON COLUMN "retention"."created_by" IS 'User who created the policy; null for an automatic default policy or once that user is deleted.';--> statement-breakpoint
COMMENT ON TABLE "scope" IS 'Which databases a login may use: one row per login and database; what it may do in them is `login.privileges`.';--> statement-breakpoint
COMMENT ON TABLE "secret" IS 'Org-owned sealed secret for storage providers and git deploy keys; `secret_envelope` is one `tpsecret` payload, written today only by the deploy-key route.';--> statement-breakpoint
COMMENT ON COLUMN "secret"."metadata" IS 'Non-secret descriptors; for `git_deploy_key` rows: `publicKey`, `fingerprint` and `keyType` (`ed25519`).';--> statement-breakpoint
COMMENT ON COLUMN "secret"."principal_id" IS 'Optional association with a principal (SET NULL on delete so a principal delete never fails on an org secret); no current writer sets it.';--> statement-breakpoint
COMMENT ON COLUMN "secret"."provider" IS '`s3`, `s3_compatible`, `nfs`, `cifs`, `sftp`, `ftp`, `webdav` (reserved storage providers) or `git_deploy_key` (the only one written today).';--> statement-breakpoint
COMMENT ON COLUMN "secret"."name" IS 'Operator label for the secret; not an identifier and not unique.';--> statement-breakpoint
COMMENT ON COLUMN "secret"."secret_envelope" IS '`tpsecret` envelope of provider-specific JSON; for `git_deploy_key` the sealed plaintext is the OpenSSH private key verbatim, resealed unopened for the daemon.';--> statement-breakpoint
COMMENT ON TABLE "server" IS 'One enrolled host per row (uuidv7 id); daemon enroll and heartbeats project host facts onto it, operators set the name, options and pins via PATCH.';--> statement-breakpoint
COMMENT ON COLUMN "server"."metadata" IS 'Daemon-projected host facts jsonb: `resources`, `geo`, `docker`, `runtimes`, `cell` plus the operator `hardwareProfile`; hostname, OS and NTP have own columns.';--> statement-breakpoint
COMMENT ON COLUMN "server"."options" IS 'Operator config served by GET /servers: `timezone`, `sshPort`, `ntp`, `hosting`, `cellLocationHint`, `cellGeneration`, `metricsCapabilityPlan`, `phpModes`.';--> statement-breakpoint
COMMENT ON COLUMN "server"."organization_id" IS 'Owning organization, nullable; ON DELETE RESTRICT so an organization that still has server rows cannot be deleted.';--> statement-breakpoint
COMMENT ON COLUMN "server"."name" IS 'Optional operator-chosen display name, set when the registration key is minted or via PATCH; the UI falls back to `hostname` when null.';--> statement-breakpoint
COMMENT ON COLUMN "server"."hostname" IS 'Daemon-reported host name written on enroll, hello and identity projection; used with `machine_key` to match a reconnecting daemon to its row.';--> statement-breakpoint
COMMENT ON COLUMN "server"."machine_key" IS 'Deterministic HMAC-SHA256 digest of the host machine-id (never the raw id, not a secret), echoed into signed enroll/auth payloads and used to match reconnects.';--> statement-breakpoint
COMMENT ON COLUMN "server"."os_id" IS 'Distro `ID` from /etc/os-release as reported by the daemon; Raspberry Pi OS (including 64-bit `ID=debian` with /etc/rpi-issue) is stored as `raspberry-pi-os`.';--> statement-breakpoint
COMMENT ON COLUMN "server"."os_family" IS 'Daemon-reported OS family, one of `linux`, `windows`, `freebsd` or `darwin`.';--> statement-breakpoint
COMMENT ON COLUMN "server"."os_version" IS 'Daemon-reported OS version, preferring `DEBIAN_VERSION_FULL` or /etc/debian_version over `VERSION_ID` (such as `13.5`).';--> statement-breakpoint
COMMENT ON COLUMN "server"."os_codename" IS 'Daemon-reported `VERSION_CODENAME` from /etc/os-release.';--> statement-breakpoint
COMMENT ON COLUMN "server"."os_pretty_name" IS 'Daemon-reported `PRETTY_NAME` from /etc/os-release.';--> statement-breakpoint
COMMENT ON COLUMN "server"."os_architecture" IS 'Daemon-reported CPU architecture from the Deno build, such as `x86_64` or `aarch64`.';--> statement-breakpoint
COMMENT ON COLUMN "server"."machine_class" IS '`physical` or `virtual` for sensor entitlement; NULL means auto, where ingest writes `physical` once sensors are found (never `virtual`); PATCH can pin.';--> statement-breakpoint
COMMENT ON COLUMN "server"."machine_class_source" IS 'Who set `machine_class`: `detected` (ingest wrote it back from the topology) or `operator` (a PATCH pinned or cleared it); NULL while the class is NULL.';--> statement-breakpoint
COMMENT ON COLUMN "server"."timezone" IS 'Daemon-observed IANA host timezone; the operator override lives in `options.timezone` and wins when set.';--> statement-breakpoint
COMMENT ON COLUMN "server"."is_time_sync_enabled" IS 'Daemon-reported NTP client enabled flag (`ntpEnabled` from the systemd-timesyncd facts); NULL when never reported.';--> statement-breakpoint
COMMENT ON COLUMN "server"."ntp_servers" IS 'Daemon-reported jsonb array of objects with `host` and optional `fallback` (FallbackNTP entries), read from timesyncd.conf or timedatectl.';--> statement-breakpoint
COMMENT ON COLUMN "server"."ntp_last_synced_at" IS 'Last successful NTP sync: set from the daemon stamp or first synced observation, cleared when the host reports unsynced, never bumped to now() per heartbeat.';--> statement-breakpoint
COMMENT ON COLUMN "server"."assigned_tier_id" IS 'Purchased tier covering this server, recomputed by assignment-records.ts from seats, `preferred_tier_id`, and hardware; NULL if none.';--> statement-breakpoint
COMMENT ON COLUMN "server"."preferred_tier_id" IS 'Optional operator pick: assignment uses a spare license at this tier or the smallest tier above before the derived smallest that fits; NULL derives only.';--> statement-breakpoint
COMMENT ON COLUMN "server"."is_connected" IS 'Daemon liveness flag written by the cell projection on connect and disconnect; `online`, `offline` or `unknown` is derived from it and `status_changed_at`.';--> statement-breakpoint
COMMENT ON COLUMN "server"."status_changed_at" IS 'Time of the last `is_connected` flip in either direction; read as `connectedAt` while connected and offline-since otherwise, NULL if never transitioned.';--> statement-breakpoint
COMMENT ON COLUMN "server"."daemon" IS 'Sparse jsonb with an optional `projection` (hostname, machineKey, remoteAddress, keyId, daemonBuild) written by the cell; the key lives in `key`.';--> statement-breakpoint
COMMENT ON COLUMN "server"."is_hosting_enabled" IS 'Boolean mirror of validated `options.hosting.enabled`, written by the same PATCH route so system/reconcile.ts can filter hosting in SQL; NULL means not set.';--> statement-breakpoint
COMMENT ON COLUMN "server"."hardware" IS 'Latest hardware layout the daemon reported (generation, boot generation, snapshot, times); overwritten in place, no history, never read by list screens.';--> statement-breakpoint
COMMENT ON COLUMN "server"."capability" IS 'Latest resolved metrics capability plan (generation, hash, plan, applied time); overwritten in place and recomputable from the box size and hardware.';--> statement-breakpoint
COMMENT ON COLUMN "server"."offline_reason" IS 'Why the host is offline: `disconnect` (socket closed) or `sweep_stale` (no heartbeat, likely power loss); NULL while online.';--> statement-breakpoint
COMMENT ON COLUMN "server"."daemon_commit" IS 'Commit of the daemon build running on the host, from its hello or heartbeat.';--> statement-breakpoint
COMMENT ON COLUMN "server"."daemon_built_at" IS 'Build time of the daemon build running on the host.';--> statement-breakpoint
COMMENT ON COLUMN "server"."daemon_update_status" IS 'Daemon self-update state: `idle`, `updating`, `done`, `failed` or `expired`; NULL until the host reports one.';--> statement-breakpoint
COMMENT ON COLUMN "server"."external_access_pending_at" IS 'When the host was last asked to change database external access and has not confirmed; a sweep re-sends it while set.';--> statement-breakpoint
COMMENT ON TABLE "service" IS 'One deployable unit (a compose service) within an environment; rows are derived from the compose document by reconcile, managed allocation or daemon reports.';--> statement-breakpoint
COMMENT ON COLUMN "service"."metadata" IS 'Client jsonb for non-indexed facts plus the daemon-detected `app` fact; promoted identity keys are stripped on write and the compose name never lives here.';--> statement-breakpoint
COMMENT ON COLUMN "service"."options" IS 'Validated per-service settings jsonb: `instances`, `build`, `operations`, `healthCheck`, `resources`, plus deploy hooks when the organization enables them.';--> statement-breakpoint
COMMENT ON COLUMN "service"."name" IS 'User-facing label (formerly `display_name`), nullable and not unique; reconcile defaults it to the compose service key.';--> statement-breakpoint
COMMENT ON COLUMN "service"."description" IS 'Optional free-text description written by the client API.';--> statement-breakpoint
COMMENT ON COLUMN "service"."compose_service_name" IS 'Compose service key, derived only: written by compose reconcile, managed allocation and daemon-report reconcile, never by a client; unique per environment.';--> statement-breakpoint
COMMENT ON COLUMN "service"."slug" IS 'Folder name under the site owner tree, unique per environment; set at creation, locked once a `folder` row exists, NULL until set.';--> statement-breakpoint
COMMENT ON COLUMN "service"."is_common" IS 'True when the folder is in the `common` scope shared by every environment; chosen at creation and never changed.';--> statement-breakpoint
COMMENT ON TABLE "session" IS 'One row per signed-in session keyed by the opaque cookie `token`; rows are deleted (never extended) on sign-out or security changes and ignored once expired.';--> statement-breakpoint
COMMENT ON COLUMN "session"."expires_at" IS 'Fixed at creation to now + 7 days (`SESSION_EXPIRES_IN_MS`); never extended, and lookups treat rows past it as absent.';--> statement-breakpoint
COMMENT ON COLUMN "session"."token" IS 'Opaque server-generated value, 32 random bytes base64url-encoded; unique, carried by the session cookie and matched verbatim.';--> statement-breakpoint
COMMENT ON COLUMN "session"."ip_address" IS 'Client address captured at sign-in as IPv4 or IPv6 text (hence 45 chars); informational only, null when unknown.';--> statement-breakpoint
COMMENT ON COLUMN "session"."user_agent" IS 'Browser UA request header captured at sign-in; informational only, null when unknown.';--> statement-breakpoint
COMMENT ON TABLE "setting" IS 'Instance-wide key/value store: one row per upper-case `key` with a JSON `value`, written by the settings resolvers, install state and the billing side-ledgers.';--> statement-breakpoint
COMMENT ON COLUMN "setting"."key" IS 'Unique upper-case key such as `SYSTEM_EMAIL`, `SYSTEM_AUTH_PROVIDERS`, `IS_SIGNUP_ENABLED`, or `BILLING_PENDING_CHANGES:` followed by an organization id.';--> statement-breakpoint
COMMENT ON COLUMN "setting"."value" IS 'JSON value for the key (scalar, array or object); any secret inside it is stored only as a sealed `tpsecret` envelope, never in plaintext.';--> statement-breakpoint
COMMENT ON TABLE "share" IS 'An environment using a common asset, a service or volume shared by a site owner; the asset cannot be deleted while a row names it.';--> statement-breakpoint
COMMENT ON COLUMN "share"."environment_id" IS 'The environment that uses the common asset; it may belong to any project of the organization.';--> statement-breakpoint
COMMENT ON COLUMN "share"."service_id" IS 'The common service being used; exactly one of service_id and storage_id is set.';--> statement-breakpoint
COMMENT ON COLUMN "share"."storage_id" IS 'The common volume being used; exactly one of service_id and storage_id is set.';--> statement-breakpoint
COMMENT ON TABLE "slot" IS 'One scheduled replica instance of a service on a server; derived scheduling state the planner writes through `replaceEnvironmentSlots` on each deploy.';--> statement-breakpoint
COMMENT ON COLUMN "slot"."server_id" IS 'Server the planner placed this replica on; sticky across re-plans (only `generation` is rewritten) unless the planner moves it; ON DELETE RESTRICT.';--> statement-breakpoint
COMMENT ON COLUMN "slot"."address" IS 'Cross-host inet address allocated on the environment''s spanning compose network; at most one per slot, NULL clears a prior allocation.';--> statement-breakpoint
COMMENT ON COLUMN "slot"."slot" IS '0-based replica index within the service (unlike 1-based `container.ordinal`), unique per service.';--> statement-breakpoint
COMMENT ON COLUMN "slot"."generation" IS 'Environment deploy generation of the plan that last wrote this row; matches `deployment.desired_generation`.';--> statement-breakpoint
COMMENT ON COLUMN "slot"."desired_state" IS 'Intended state, `running`, `stopped` or `removed`; the planner only writes `running` today.';--> statement-breakpoint
COMMENT ON TABLE "snapshot" IS 'One finished scheduled run of a `retention`, reported by the host that ran it; unique per (retention_id, run_id).';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."retention_id" IS 'The `retention` this run belongs to; the run history cascades with it.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."run_id" IS 'Daemon-minted id for the run, unique per policy so a report delivered twice is recorded once.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."started_at" IS 'When the host started the run.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."finished_at" IS 'When the host finished the run, whether it succeeded or failed.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."status" IS '`succeeded` or `failed`, as reported by the host.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."error" IS 'Failure text reported by the host; null when the run succeeded.';--> statement-breakpoint
COMMENT ON COLUMN "snapshot"."backup_ref" IS 'The `bk_` id of the artifact the run produced, matching `backup.backup_id` or `archive.backup_id`; null when it failed.';--> statement-breakpoint
COMMENT ON TABLE "ssh" IS 'A public key that may authenticate as a principal over SSH; the daemon renders `authorized_keys` from it, and fingerprint lookups answer lost-laptop revocation.';--> statement-breakpoint
COMMENT ON COLUMN "ssh"."name" IS 'Operator-facing label (1 to 255 chars), distinct from the key''s own `comment`.';--> statement-breakpoint
COMMENT ON COLUMN "ssh"."key_type" IS 'SSH key algorithm from the CHECK list (`ssh-ed25519`, `ecdsa-sha2-nistp*`, their `sk-` FIDO variants, `ssh-rsa`); `ssh-dss` is rejected.';--> statement-breakpoint
COMMENT ON COLUMN "ssh"."public_key" IS 'Canonical `type base64` re-rendered from the decoded blob, never the pasted line; the comment moves to `comment` and a leading options field is rejected.';--> statement-breakpoint
COMMENT ON COLUMN "ssh"."fingerprint" IS '`SHA256:` plus unpadded base64 digest of the decoded blob, byte-identical to `ssh-keygen -lf`; unique per principal.';--> statement-breakpoint
COMMENT ON COLUMN "ssh"."comment" IS 'Sanitized display comment from the pasted line (printable ASCII, no quotes or backslashes, max 255); NULL when none.';--> statement-breakpoint
COMMENT ON COLUMN "ssh"."user_id" IS 'Org member who added the key: audit provenance, not ownership; set NULL on user delete so the key survives.';--> statement-breakpoint
COMMENT ON COLUMN "ssh"."bits" IS 'RSA modulus size in bits (minimum 2048); NULL for the fixed-size key types.';--> statement-breakpoint
COMMENT ON TABLE "stage" IS 'One `daemon` or `instance` install on one server inside an upgrade run, advanced by the orchestrator until a terminal outcome.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."unit" IS '`daemon` or `instance`: the package this step installs on its server.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."phase" IS 'Which part of the run the step belongs to: `colocated_daemon` first, then `control_plane`, then `fleet`; checked against the run order.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."batch_index" IS 'Zero-based wave index within the run; steps that share an index are dispatched together.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."status" IS '`pending`/`waiting`/`dispatched`/`preparing`/`downloading`/`installing`/`restarting`/`verifying`/`done`/`failed`/`rolled_back`/`needs_attention`/`skipped`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."request_id" IS 'Cell correlation id for the in-flight install; NULL until the step is dispatched.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."attempts" IS 'Dispatch count for this step, starting at 0 and incremented before each retry.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."next_attempt_at" IS 'Earliest time a non-terminal step may be retried; NULL when no retry is scheduled.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."from_version" IS 'Version installed before this step ran; NULL when the host had none.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."to_version" IS 'Version this step installs, copied from the run target for `unit`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."from_commit" IS 'Commit installed before this step ran; NULL when it was unknown.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."to_commit" IS 'Commit this step installs, copied from the run target for `unit`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."status_changed_at" IS 'When `status` last changed, so a step stuck in one stage can be detected.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."error_code" IS 'Machine-readable code when the step fails, rolls back or needs attention.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."error_message" IS 'Human-readable failure text set alongside `error_code`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."detail" IS 'Small stage facts such as bytes fetched or an exit code; the orchestrator writes it, never a transcript.';--> statement-breakpoint
COMMENT ON TABLE "storage" IS 'Logical identity of persistent data owned by an organization and scoped to at most one of workspace, project, environment or service; bytes live on `copy` rows.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."metadata" IS 'Free-form jsonb from the API; `dockerVolumeName` is stamped to the storage UUID on volume create because the Docker volume name is the storage id.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."options" IS 'Free-form jsonb passed through from the storage API; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."organization_id" IS 'Owning organization stored directly (an intentional exception to derived ownership); cascade-deletes the storage with the org.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."workspace_id" IS 'Optional workspace scope, at most one scope column may be set; SET NULL on delete so a `retain` row survives as org-owned storage.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."project_id" IS 'Optional project scope, at most one scope column may be set; SET NULL on delete so a `retain` row survives as org-owned storage.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."environment_id" IS 'Optional environment scope (compose volumes are environment-scoped), at most one scope column set; SET NULL on delete so `retain` rows survive.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."service_id" IS 'Optional service scope, at most one scope column may be set; SET NULL on delete so a `retain` row survives as org-owned storage.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."kind" IS '`volume` (named Docker volume), `directory`, `file` (sealed content) or `object` (reserved, not accepted by the API).';--> statement-breakpoint
COMMENT ON COLUMN "storage"."name" IS 'Operator label, or the Compose volume key for auto-registered volumes; up to 255 chars with no charset CHECK.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."access_mode" IS '`single_writer` (default), `multi_reader` or `multi_writer`; single_writer refuses a deploy scheduled on a server other than the primary copy''s.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."retention" IS '`retain` (default) keeps the row as org-owned when its scope parent is deleted; `delete` removes it with the parent.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."principal_id" IS 'Optional owning system principal; path copies without an explicit `path` resolve under that principal''s volumes directory; SET NULL on delete.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."content_envelope" IS 'Sealed file content for `kind=''file''` entries (`tpsecret` at rest, resealed to `tpdaemon` at deploy); up to 256 KiB plaintext; null otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."compose_volume_key" IS 'Compose top-level volume key for auto-registered `volume` rows; unique per environment and the idempotency key for compose volume registration.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."slug" IS 'Folder name of a panel-owned volume under the site owner tree; set at creation, locked once a `folder` row exists, NULL until set.';--> statement-breakpoint
COMMENT ON COLUMN "storage"."is_common" IS 'True when the volume folder is in the `common` scope shared by every environment; chosen at creation and never changed.';--> statement-breakpoint
COMMENT ON TABLE "copy" IS 'One physical copy of a storage identity (docker volume or host path today); one `primary` per storage, local copies pin `server_id`, remote ones leave it null.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."metadata" IS 'Free-form jsonb passed through from the copy API; no keys are read by the platform today.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."options" IS 'Provider options: compose-registered docker copies carry `managed` (true when Compose owns the volume) and `externalName` for external volumes.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."server_id" IS 'Host holding a local `docker` or `path` copy, unique with storage and provider; null for remote/shared providers; ON DELETE RESTRICT.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."secret_id" IS 'Optional provider credential from `secret` for remote providers; ON DELETE RESTRICT; unused by the docker and path providers.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."provider" IS '`docker` or `path` today; `block`, `nfs`, `cifs`, `s3`, `s3_compatible`, `sftp`, `ftp` and `webdav` are reserved and not accepted by the API.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."role" IS '`primary` (one per storage; anchors the access-mode placement check), `replica`, `scratch` (never mountable) or `archive`.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."state" IS 'Materialization state: `pending`, `materializing`, `ready`, `syncing`, `stale`, `failed` or `retiring`; set via the API, defaults to `pending`.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."path" IS 'Host filesystem path for a `path` copy; null means the platform layout or the principal''s volumes directory is resolved at deploy and never persisted.';--> statement-breakpoint
COMMENT ON COLUMN "copy"."endpoint" IS 'Remote endpoint for network providers; API passthrough, unused by `docker` and `path` copies.';--> statement-breakpoint
COMMENT ON TABLE "subnet" IS 'Per-server realization of a `kind = ''compose''` spanning network, one row per network and server, written by `ensureNetworkSubnet` when spanning networks build.';--> statement-breakpoint
COMMENT ON COLUMN "subnet"."metadata" IS 'Free-form jsonb; no control-plane code path writes or reads it today.';--> statement-breakpoint
COMMENT ON COLUMN "subnet"."network_id" IS 'Spanning network (`kind = ''compose''` row) this per-server subnet realizes, unique together with `server_id`; rows cascade away with the network.';--> statement-breakpoint
COMMENT ON COLUMN "subnet"."server_id" IS 'Server hosting this segment; delete is restricted, so `deleteServerFabricMembership` removes the subnets first.';--> statement-breakpoint
COMMENT ON COLUMN "subnet"."cidr" IS 'Server-local Docker bridge subnet for the network, the lowest free /24 carved from the server''s `relay.prefix` around org exclusions by `requireSubnetCidr`.';--> statement-breakpoint
COMMENT ON TABLE "subscription" IS 'One provider subscription per `payer`, upserted by the Stripe webhook on `provider_subscription_id`; holds status, period end, parked schedule and grace clock.';--> statement-breakpoint
COMMENT ON COLUMN "subscription"."provider_subscription_id" IS 'Provider-side subscription id (Stripe `sub_...`); unique and the conflict target of the webhook upsert.';--> statement-breakpoint
COMMENT ON COLUMN "subscription"."status" IS 'Checked status: `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`, or `unknown` for an unrecognised value.';--> statement-breakpoint
COMMENT ON COLUMN "subscription"."provider_status" IS 'Provider status string verbatim, never interpreted; kept beside `status` so an unknown Stripe value lands as `unknown` plus the raw string, not a refused event.';--> statement-breakpoint
COMMENT ON COLUMN "subscription"."current_period_end" IS 'End of the current billing period as the provider reports it, taken from the subscription or else its first item; null when the provider gives none.';--> statement-breakpoint
COMMENT ON COLUMN "subscription"."schedule_id" IS 'Provider subscription schedule id (Stripe `sub_sched_...`) while a downgrade is parked on a schedule; null otherwise, written by the webhook projection.';--> statement-breakpoint
COMMENT ON COLUMN "subscription"."grace_expires_at" IS 'Always null since the TurboPanel grace clock was removed: provider retries now end a past-due subscription. Kept by the schema freeze, never read.';--> statement-breakpoint
COMMENT ON COLUMN "subscription"."past_due_since" IS 'First moment the provider reported `past_due` or `unpaid`; latched while delinquent, cleared by any other status so a later lapse is measured afresh.';--> statement-breakpoint
COMMENT ON TABLE "seat" IS 'Subscription line: `quantity` purchased licenses at one `tier`, projected from provider subscription items by the Stripe webhook (export `subscriptionItem`).';--> statement-breakpoint
COMMENT ON COLUMN "seat"."tier_id" IS 'Tier this line counts against, resolved from the item product via `tier.provider_product_id`; unique per subscription, RESTRICT so a used tier stays readable.';--> statement-breakpoint
COMMENT ON COLUMN "seat"."provider_item_id" IS 'Provider-side subscription item id (Stripe `si_...`), unique; when two provider items map to one tier the row keeps the first id with the summed quantity.';--> statement-breakpoint
COMMENT ON COLUMN "seat"."provider_price_id" IS 'Provider price the item bills at (Stripe `price_...`), projected from the item and restated by every mutation; the tier knows its product, not its price.';--> statement-breakpoint
COMMENT ON COLUMN "seat"."quantity" IS 'Number of licenses purchased at this tier, copied from the provider item quantity (summed when items share a tier); an ended subscription counts as zero.';--> statement-breakpoint
COMMENT ON TABLE "tag" IS 'Organization-owned tag definition written by the tags routes; names are labels unique per organization after lower-casing and trimming.';--> statement-breakpoint
COMMENT ON COLUMN "tag"."name" IS 'Operator-chosen label, unique per organization on `lower(btrim(name))`; no format CHECK in the database.';--> statement-breakpoint
COMMENT ON COLUMN "tag"."description" IS 'Optional free-text description normalized like a display name; NULL when empty.';--> statement-breakpoint
COMMENT ON COLUMN "tag"."color" IS 'Optional display colour as a `#rgb` or `#rrggbb` hex string; NULL when unset.';--> statement-breakpoint
COMMENT ON TABLE "task" IS 'Cron-style scheduled command on a service, created and edited by operators via the tasks API and rendered into systemd timers at deploy time; no run history.';--> statement-breakpoint
COMMENT ON COLUMN "task"."metadata" IS 'Accepted by the record helper but never written by the tasks API today; reserved.';--> statement-breakpoint
COMMENT ON COLUMN "task"."options" IS 'Accepted by the record helper but never written by the tasks API today; reserved.';--> statement-breakpoint
COMMENT ON COLUMN "task"."name" IS 'Operator display name, unique per service and normalized as a display name (no format CHECK).';--> statement-breakpoint
COMMENT ON COLUMN "task"."schedule" IS 'Cron expression validated by `parseCronSchedule` in lib/cron.ts and converted to a systemd `OnCalendar` value at deploy time.';--> statement-breakpoint
COMMENT ON COLUMN "task"."command" IS 'Shell command line to run (under 1000 chars, each argument under 512), validated by `parseCronCommand`.';--> statement-breakpoint
COMMENT ON COLUMN "task"."timezone" IS 'Optional IANA timezone (validated against the allowed list) applied when the schedule is converted to a systemd `OnCalendar` value; NULL means none set.';--> statement-breakpoint
COMMENT ON COLUMN "task"."is_enabled" IS 'Operator toggle; a disabled task stays stored but `renderCronForDeploy` skips it, so no timer is rendered at deploy time.';--> statement-breakpoint
COMMENT ON COLUMN "task"."concurrency_policy" IS 'What happens when a run is still going at the next tick: `allow` overlapping runs, `forbid` skips the tick (default), `replace` restarts the run.';--> statement-breakpoint
COMMENT ON COLUMN "task"."timeout_seconds" IS 'Longest a run may take before it is stopped, at most 86400 (24h); NULL means no declared limit.';--> statement-breakpoint
COMMENT ON TABLE "team" IS 'Team within an organization; every org gets a `Default Team` at creation, and membership in any of its teams is what makes a user an org member.';--> statement-breakpoint
COMMENT ON COLUMN "team"."name" IS 'Display label of 1-255 chars, `Default Team` for the team created with the organization; no route creates or renames teams today.';--> statement-breakpoint
COMMENT ON TABLE "teammate" IS 'User-to-team membership row (unique per pair), the source of truth for organization membership; written at org creation and on invitation accept.';--> statement-breakpoint
COMMENT ON COLUMN "teammate"."team_id" IS 'Team joined; unique together with `user_id`, and organization membership is derived through `team.organization_id` rather than stored here.';--> statement-breakpoint
COMMENT ON TABLE "tenancy" IS 'Join edge marking the Linux/system principal a compose service runs as; unique (principal_id, service_id), written by the principal store and compose reconcile.';--> statement-breakpoint
COMMENT ON COLUMN "tenancy"."principal_id" IS 'System principal that stewards the service (runs as, owns the site tree); cascade-deleted with the principal.';--> statement-breakpoint
COMMENT ON COLUMN "tenancy"."service_id" IS 'Consuming compose service; ON DELETE RESTRICT so a service delete must clear its run-as edges first.';--> statement-breakpoint
COMMENT ON TABLE "tier" IS 'Global billed offering: one row per ladder label (`S1` to `S7`, `SX`) bound to a provider product; written under Admin Tiers, deactivated and never deleted.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."label" IS 'Ladder label `S1` to `S7` or `SX`, the unique key into the in-code ladder (`src/features/tiers/ladder.ts`) that holds everything the tier entitles.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."rank" IS 'Ladder position copied from the in-code ladder on insert, never from a request; unique, orders tiers and decides upgrade versus downgrade and greedy assignment.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."provider" IS 'Payment provider the row bills through; only `stripe` is allowed today (CHECK `tier_provider_check`), matching `payer.provider`.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."provider_product_id" IS 'Provider Product id (Stripe `prod_...`) chosen from the provider catalogue and verified before write; null on the custom `SX` row, which is never purchasable.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."price_cents" IS 'Display cache of the product default price in minor units, written on verify and refreshed by the provider price webhooks; nothing does arithmetic on it.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."currency" IS 'Display cache beside `price_cents`: lower-case ISO currency code of the provider default price, written on verify and by the price webhooks.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."is_custom" IS 'Copied from the in-code ladder on insert (true only for `SX`); identity like `label` and `rank`, never changed by a patch.';--> statement-breakpoint
COMMENT ON COLUMN "tier"."is_active" IS 'Set false by a superadmin to hide the tier from new purchases; rows are deactivated, never deleted, so seats that count against it keep resolving.';--> statement-breakpoint
COMMENT ON TABLE "tls" IS 'Per-organization TLS library: uploaded, Let''s Encrypt, self-signed certificates and the Organization CA generations; `hosting.tls_id` pins rows by id.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."metadata" IS 'Certificate facts not promoted to columns: `dnsNames`, `hasWildcard`, `notBefore`, `subject`, `issuer` and `acme` (`challengeType`, `managedBy`, `lastError`).';--> statement-breakpoint
COMMENT ON COLUMN "tls"."options" IS 'Operator knobs: `prefer` (pin priority), `autoRenew`, and `requestedHostnames` asked for on Let''s Encrypt or self-signed create; null on Organization CA rows.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."name" IS 'Operator label of 1-255 letters, digits, space, dot, underscore or dash; fixed `Organization CA` on CA rows.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."source" IS '`upload`, `lets_encrypt` (Caddy-managed ACME on the host), `self_signed` or `organization_ca`; decides which other columns are meaningful.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."certificate_pem" IS 'Leaf plus intermediate chain PEM; null on `lets_encrypt` rows because Caddy issues and holds the certificate on the serving host.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."private_key_pem" IS 'Private key PEM sealed as a `tpsecret` envelope, never returned by the client API; null on `lets_encrypt` rows.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."status" IS 'Row health `ready`, `pending`, `expired`, `failed`, `revoked` or `managed` (Caddy ACME intent); `expired` is derived at read from `not_after`, others stored.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."not_after" IS 'Certificate expiry parsed from the PEM at write; epoch-0 placeholder on `managed` rows; indexed for expiry checks.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."fingerprint_sha256" IS 'SHA-256 fingerprint of the leaf DER, unique per organization when set; null on `managed` rows that have no certificate yet.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."ca_state" IS 'Organization CA lifecycle `active` (one per org), `retired` (still in the trust bundle) or `revoked`; null on non-CA rows.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."ca_generation" IS 'Monotonic per-org counter (max + 1) assigned when a CA is minted; leaves record which generation signed them; null on non-CA rows.';--> statement-breakpoint
COMMENT ON TABLE "totp" IS 'TOTP enrolment for a user, at most one row per user (`uniq_totp_user_id`); inserted or reset on enable, verified once, and deleted when two-factor is disabled.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."user_id" IS 'Enrolled user; unique, so re-enabling resets the existing row instead of adding one, and disable deletes it.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."secret" IS 'TOTP shared secret sealed as a `tpsecret` envelope with the data-encryption key; never plaintext and never returned after enrolment.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."is_verified" IS 'False until the user proves the first six-digit code; only a verified row turns on `user.is_2fa_enabled` and receives backup codes.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."backup_codes" IS 'JSON array of HMAC verifier envelopes (`tpotp.vN.hex`) for the ten one-time backup codes, `[]` until verified; a used code is removed from the array.';--> statement-breakpoint
COMMENT ON TABLE "upgrade" IS 'One instance-wide upgrade run, written by the upgrade orchestrator, with at most one `pending` or `running` row.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."target" IS 'Pins for `daemon`, `instance` and `ui`: version, commit, build id, built-at time and pinned manifest URL; NULL until resolved.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."preflight" IS 'Checks recorded before the first dispatch: blockers, version floors and which units this run will touch.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."source" IS 'Who started the run: `manual` from the panel, `auto` from the scheduler, or `server` for a single-host request.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."channel" IS 'Update channel the run follows (`trunk`, `canary`, `rc` or `release`), copied from the instance when the run is created.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."status" IS 'Lifecycle `pending`, `running`, `succeeded`, `partially_failed`, `failed` or `cancelled`; the orchestrator advances it.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."phase" IS 'Current wave `colocated_daemon`, `control_plane` or `fleet`; NULL until the orchestrator enters the first wave.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."started_by" IS 'User who started a manual run; NULL for an automatic run and after that account is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."batch_policy" IS 'Snapshot of upgrade settings (auto-update, batch size and maintenance window) taken when the run starts.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."counts" IS 'Terminal step totals written when the run finishes, so the summary remains after old steps are pruned.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."error" IS 'Run-level failure text when the status is `failed` or `partially_failed`; NULL on success.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."started_at" IS 'When the orchestrator moved the run from `pending` to `running`.';--> statement-breakpoint
COMMENT ON COLUMN "upgrade"."finished_at" IS 'When the run reached a terminal status.';--> statement-breakpoint
COMMENT ON TABLE "user" IS 'One row per person who can sign in to the instance, keyed by unique `email`; created by password sign-up, OTP sign-in, OAuth sign-up or the install wizard.';--> statement-breakpoint
COMMENT ON COLUMN "user"."name" IS 'Optional display name copied at creation from the OAuth profile or the OTP sign-in form (1-255 chars); absent on password sign-up and never edited later.';--> statement-breakpoint
COMMENT ON COLUMN "user"."email" IS 'Unique sign-in address, trimmed at write; the identity that accounts, sessions, OTP flows and invitation accepts are matched against.';--> statement-breakpoint
COMMENT ON COLUMN "user"."is_email_verified" IS 'True once the address is proven: set at creation by OTP or OAuth sign-up and the install wizard, or later by the verify-email link and OTP routes.';--> statement-breakpoint
COMMENT ON COLUMN "user"."is_2fa_enabled" IS 'Derived flag kept in step with the `totp` row: set true when TOTP enrolment is verified and false when two-factor is disabled.';--> statement-breakpoint
COMMENT ON COLUMN "user"."is_disabled" IS 'Sign-in gate read by every authn path (password, OTP, passkey, OAuth) and refused with `account_disabled`; no control-plane route writes it today.';--> statement-breakpoint
COMMENT ON COLUMN "user"."role" IS 'Instance role `user`, `admin` or `superadmin`; sign-ups get `user`, the install wizard mints the one `superadmin`, and admins bypass org grants.';--> statement-breakpoint
COMMENT ON COLUMN "user"."time_zone" IS 'IANA zone (from the supported list) in which quiet hours on the personal channels of this user are read; NULL means UTC.';--> statement-breakpoint
COMMENT ON TABLE "variable" IS 'One config key/value at exactly one scope (organization, workspace, project, environment, service, hosting or server), resolved narrowest-wins into deploy env.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."organization_id" IS 'Organization scope parent, the widest inheritance level; exactly one of the seven scope columns is non-null (`variable_exactly_one_parent_check`).';--> statement-breakpoint
COMMENT ON COLUMN "variable"."workspace_id" IS 'Workspace scope parent, overriding organization values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."project_id" IS 'Project scope parent, overriding workspace values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."environment_id" IS 'Environment scope parent, overriding project values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."service_id" IS 'Service scope parent, overriding environment values; exactly one of the seven scope columns is non-null, and rows cascade with the parent.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."hosting_id" IS 'Hosting scope parent, the narrowest level, merged per service at deploy (later hosting wins); exactly one of the seven scope columns is non-null.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."server_id" IS 'Server scope parent, resolved per server at deploy and outside the inheritance chain; exactly one of the seven scope columns is non-null.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."binding_id" IS 'When set the row is system-owned, materialized by a managed-database binding; client PATCH/DELETE return 403 and the row cascades with the binding.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."key" IS 'Environment variable name matching `^[A-Za-z_][A-Za-z0-9_]*$`, unique per scope parent via partial unique indexes.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."value" IS 'Plaintext for non-secrets; for secrets a sealed `tpsecret` envelope (data-encryption key) the API never returns and deploy delivers as a file.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."is_secret" IS 'True marks the value sealed and write-only: read back as null, never interpolated into YAML or `.env`, compiled to a Compose secret file at deploy.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."is_literal" IS 'True escapes `$` so Docker Compose does not interpolate the value; false leaves a `$OTHER` reference for Compose to expand (API field `isLiteral`).';--> statement-breakpoint
COMMENT ON COLUMN "variable"."is_for_build" IS 'True injects the non-secret value into `build.args` at deploy (API field `forBuild`); default false.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."is_for_runtime" IS 'True injects the non-secret value into the container `environment` at deploy (API field `forRuntime`); default true.';--> statement-breakpoint
COMMENT ON COLUMN "variable"."description" IS 'Optional free-text note written by the client API.';--> statement-breakpoint
COMMENT ON TABLE "verification" IS 'Short-lived email verification tokens and OTP verifiers keyed by unique `identifier`; rows are upserted per purpose and deleted or left to expire on use.';--> statement-breakpoint
COMMENT ON COLUMN "verification"."expires_at" IS 'Hard expiry compared at read: 24 h for verify-email links, 300 s for OTPs and their attempt counters; expired rows are ignored and replaced.';--> statement-breakpoint
COMMENT ON COLUMN "verification"."identifier" IS 'Lookup key: the bare email for verify-email links, `otp:TYPE:sha256(email)` for an OTP and `otp-attempts:TYPE:sha256(email)` for its attempt counter.';--> statement-breakpoint
COMMENT ON COLUMN "verification"."value" IS 'Never the raw secret: SHA-256 hex of the link token, a keyed HMAC envelope `tpotp.vN.hex` for an OTP, or the decimal failed-attempt count.';--> statement-breakpoint
COMMENT ON TABLE "watch" IS 'Which environment or project follows which repository, derived from the compose document that names it; a project row reaches every environment of the project.';--> statement-breakpoint
COMMENT ON COLUMN "watch"."environment_id" IS 'Set when the environment own compose names the repository; exactly one of this and `project_id` is set.';--> statement-breakpoint
COMMENT ON COLUMN "watch"."project_id" IS 'Set when the project compose names the repository; exactly one of this and `environment_id` is set.';--> statement-breakpoint
COMMENT ON TABLE "delivery" IS 'Replay-protection ledger of inbound webhook deliveries for every gate kind (GitHub, GitLab, Stripe); org-agnostic, secret-free, pruned after 7 days.';--> statement-breakpoint
COMMENT ON COLUMN "delivery"."provider" IS 'Webhook gate kind that claimed the delivery: `github`, `gitlab` or `stripe`.';--> statement-breakpoint
COMMENT ON COLUMN "delivery"."external_delivery_id" IS 'Provider delivery id: GitHub `X-GitHub-Delivery`, GitLab `X-Gitlab-Event-UUID` (else `sha256:` digest of the body), or the Stripe event id.';--> statement-breakpoint
COMMENT ON COLUMN "delivery"."event" IS 'Provider event name (`push`, `check_suite`, a Stripe event `type`) recorded for tracing only.';--> statement-breakpoint
COMMENT ON COLUMN "delivery"."object_id" IS 'Stripe `data.object.id` kept until projection settles so entitlement survives a crash after the 2xx; NULL for git deliveries.';--> statement-breakpoint
COMMENT ON COLUMN "delivery"."object_type" IS 'Stripe `data.object.object` (for example `subscription`) kept beside `object_id` for the projection sweep; NULL for git deliveries.';--> statement-breakpoint
COMMENT ON COLUMN "delivery"."projected_at" IS 'When the Stripe projection settled (success, skip or permanent error); NULL means pending retry and exempt from pruning, git rows stay NULL.';--> statement-breakpoint
COMMENT ON TABLE "workspace" IS 'Grouping of projects inside one organization; operator rows are `kind=''user''` and each organization also holds exactly one platform `turbopanel` workspace.';--> statement-breakpoint
COMMENT ON COLUMN "workspace"."name" IS 'Display label under `workspace_name_format_check` (letters, digits, space, `._-`), unique per organization at the API; ''TurboPanel'' is reserved from first boot.';--> statement-breakpoint
COMMENT ON COLUMN "workspace"."description" IS 'Optional free-text description written by the client API; no format CHECK, app-side length cap only.';--> statement-breakpoint
COMMENT ON COLUMN "workspace"."kind" IS 'Workspace discriminator: `user` (default, operator-created) or `turbopanel` (the single machine workspace per organization, provisioned at install).';
--> statement-breakpoint
COMMENT ON SEQUENCE "public"."principal_id_seq" IS 'Installation-wide uid/gid source for new site owner Linux users: one value per principal, the same on every server it is placed on. Starts above the band floor because older hosts picked ids from the bottom.';
