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
	"origin" text DEFAULT 'backup' NOT NULL,
	"backup_id" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "archive_backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "archive_checksum_format_check" CHECK (checksum ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "archive_size_bytes_check" CHECK (size_bytes >= 0),
	CONSTRAINT "archive_origin_check" CHECK (origin IN ('backup', 'import'))
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
	"database_id" uuid,
	"retention_id" uuid,
	"server_id" uuid,
	"origin" text DEFAULT 'backup' NOT NULL,
	"backup_id" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"database" text,
	"path" text NOT NULL,
	CONSTRAINT "backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "backup_checksum_format_check" CHECK (checksum ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "backup_size_bytes_check" CHECK (size_bytes >= 0),
	CONSTRAINT "backup_origin_check" CHECK (origin IN ('backup', 'import'))
);
--> statement-breakpoint
CREATE TABLE "shipment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"managed_id" uuid NOT NULL,
	"destination_id" uuid,
	"server_id" uuid,
	"backup_id" text NOT NULL,
	"destination_name" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"object_key" text,
	"size_bytes" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"copied_at" timestamp(3) with time zone,
	CONSTRAINT "shipment_backup_id_format_check" CHECK (backup_id ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "shipment_state_check" CHECK (state IN ('pending', 'copying', 'copied', 'failed', 'removed')),
	CONSTRAINT "shipment_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE "destination" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 's3' NOT NULL,
	"endpoint" text NOT NULL,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_key_sealed" text NOT NULL,
	"last_tested_at" timestamp(3) with time zone,
	"last_test_error" text,
	"is_path_style" boolean DEFAULT true NOT NULL,
	"is_server_side_encrypted" boolean DEFAULT false NOT NULL,
	"is_last_test_ok" boolean,
	CONSTRAINT "destination_kind_check" CHECK (kind IN ('s3')),
	CONSTRAINT "destination_name_check" CHECK (char_length(name) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "badge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"carrier_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"label" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_four" text NOT NULL,
	"last_checked_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_badge_secret_id" UNIQUE("secret_id"),
	CONSTRAINT "badge_label_check" CHECK (char_length(label) BETWEEN 1 AND 64),
	CONSTRAINT "badge_status_check" CHECK (status IN ('active', 'attention'))
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
	"preset" varchar(16),
	"is_emit_engine_defaults" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uniq_binding_service_prefix" UNIQUE("service_id","key_prefix"),
	CONSTRAINT "binding_key_prefix_format_check" CHECK ((char_length((key_prefix)::text) >= 1) AND (char_length((key_prefix)::text) <= 64) AND ((key_prefix)::text ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)),
	CONSTRAINT "binding_preset_check" CHECK (preset IS NULL OR preset IN ('postgres', 'mysql', 'laravel', 'wordpress', 'metabase', 'uptime-kuma'))
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
CREATE TABLE "cache" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"environment_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"name" varchar(63) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"engine" text DEFAULT 'valkey' NOT NULL,
	"version" varchar(16) NOT NULL,
	"access" text DEFAULT 'socket' NOT NULL,
	"port" integer,
	"max_memory_mb" integer DEFAULT 64 NOT NULL,
	"key_prefix" varchar(64) DEFAULT 'REDIS' NOT NULL,
	"password" text NOT NULL,
	CONSTRAINT "uniq_cache_environment_name" UNIQUE("environment_id","name"),
	CONSTRAINT "uniq_cache_environment_principal_prefix" UNIQUE("environment_id","principal_id","key_prefix"),
	CONSTRAINT "cache_name_check" CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
	CONSTRAINT "cache_engine_check" CHECK (engine IN ('valkey', 'redis')),
	CONSTRAINT "cache_status_check" CHECK (status IN ('pending', 'applying', 'ready', 'stopped', 'failed')),
	CONSTRAINT "cache_version_check" CHECK (version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
	CONSTRAINT "cache_access_check" CHECK ((access = 'socket' AND port IS NULL) OR (access = 'port' AND port IS NOT NULL AND port BETWEEN 1024 AND 65535)),
	CONSTRAINT "cache_max_memory_mb_check" CHECK (max_memory_mb BETWEEN 16 AND 65536),
	CONSTRAINT "cache_key_prefix_check" CHECK (key_prefix ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "carrier" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text,
	CONSTRAINT "uniq_carrier_organization_id_provider_external_account_id" UNIQUE("organization_id","provider","external_account_id"),
	CONSTRAINT "carrier_name_check" CHECK (char_length(name) BETWEEN 1 AND 64),
	CONSTRAINT "carrier_provider_check" CHECK (provider IN ('cloudflare')),
	CONSTRAINT "carrier_status_check" CHECK (status IN ('active', 'attention'))
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
	"retire_by" timestamp(3) with time zone,
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
	"datacenter_id" uuid,
	"scope" text NOT NULL,
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
	"organization_id" uuid,
	"server_id" uuid NOT NULL,
	"environment_id" uuid,
	"managed_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
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
	"status" text DEFAULT 'pending' NOT NULL,
	"container_id" text,
	"container_name" text NOT NULL,
	"role" text DEFAULT 'service' NOT NULL,
	"compose_service_name" text NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "container_ordinal_positive_check" CHECK (ordinal >= 1),
	CONSTRAINT "container_role_check" CHECK (role IN ('service', 'ingress', 'turbopanel')),
	CONSTRAINT "container_status_check" CHECK (status IN ('pending', 'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "custodian" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"passkey_id" uuid,
	"pkid" text NOT NULL,
	"alg" text NOT NULL,
	"public_key_raw" text NOT NULL,
	"rp_id" text NOT NULL,
	"label" text,
	"marked_keyset" integer NOT NULL,
	"unmarked_keyset" integer,
	"unmarked_at" timestamp(3) with time zone,
	CONSTRAINT "custodian_alg_check" CHECK (alg IN ('ES256', 'EdDSA')),
	CONSTRAINT "custodian_marked_passkey_check" CHECK ((unmarked_at IS NOT NULL) OR (passkey_id IS NOT NULL))
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
	"kind" text,
	"description" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"address_preference" text DEFAULT 'ipv6' NOT NULL,
	"is_trusted" boolean DEFAULT true NOT NULL,
	CONSTRAINT "datacenter_priority_check" CHECK (priority >= 0 AND priority <= 1000),
	CONSTRAINT "datacenter_address_preference_check" CHECK (address_preference IN ('ipv6', 'ipv4')),
	CONSTRAINT "datacenter_kind_check" CHECK (kind IS NULL OR kind IN ('lan', 'backplane', 'provider_private'))
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
	"last_command_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"desired_generation" integer DEFAULT 0 NOT NULL,
	"applied_generation" integer,
	"desired_hash" text,
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
CREATE TABLE "record" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"carrier_id" uuid,
	"ingress_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"zone_id" text NOT NULL,
	"external_id" text,
	"content" text NOT NULL,
	"ttl" integer,
	"checked_at" timestamp(3) with time zone,
	"error" text,
	"is_proxied" boolean DEFAULT false NOT NULL,
	"is_adopted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_record_scope_name_kind_content" UNIQUE NULLS NOT DISTINCT("organization_id","name","kind","content"),
	CONSTRAINT "record_kind_check" CHECK (kind IN ('A', 'AAAA', 'CNAME')),
	CONSTRAINT "record_status_check" CHECK (status IN ('pending', 'synced', 'drifted', 'removing', 'failed')),
	CONSTRAINT "record_provider_check" CHECK (provider IN ('cloudflare')),
	CONSTRAINT "record_account_check" CHECK (num_nonnulls(carrier_id, ingress_id) = 1),
	CONSTRAINT "record_scope_check" CHECK ((organization_id IS NULL) = (carrier_id IS NULL)),
	CONSTRAINT "record_name_check" CHECK (name = lower(name) AND char_length(name) BETWEEN 1 AND 253),
	CONSTRAINT "record_ttl_check" CHECK (ttl IS NULL OR ttl BETWEEN 1 AND 86400),
	CONSTRAINT "record_content_check" CHECK (char_length(content) BETWEEN 1 AND 253)
);
--> statement-breakpoint
CREATE TABLE "doorway" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"routing_organization_id" uuid NOT NULL,
	"tunnel_id" uuid NOT NULL,
	"hosting_id" uuid,
	"kind" text DEFAULT 'http' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"hostname" text NOT NULL,
	"external_dns_record_id" text,
	"is_local_only" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uniq_doorway_routing_organization_id_hostname" UNIQUE("routing_organization_id","hostname"),
	CONSTRAINT "doorway_hostname_check" CHECK (char_length(hostname) BETWEEN 1 AND 253 AND hostname = lower(hostname)),
	CONSTRAINT "doorway_kind_check" CHECK (kind IN ('http')),
	CONSTRAINT "doorway_status_check" CHECK (status IN ('pending', 'live', 'attention', 'removing'))
);
--> statement-breakpoint
CREATE TABLE "edict" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid,
	"created_by" uuid,
	"label" text NOT NULL,
	"scope" text NOT NULL,
	"action" text NOT NULL,
	"proto" text NOT NULL,
	"ports" text,
	"source_kind" text NOT NULL,
	"source_addresses" "inet"[] DEFAULT '{}'::inet[] NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
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
	"name" text DEFAULT replace(uuidv7()::text, '-', '') NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"description" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_environment_project_name" UNIQUE("project_id","name"),
	CONSTRAINT "uniq_environment_project_id" UNIQUE("project_id","id"),
	CONSTRAINT "environment_name_check" CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND name NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging', 'base'))
);
--> statement-breakpoint
CREATE TABLE "fabric" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"name" text,
	"cidr" "cidr" NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
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
	"service_id" uuid,
	"storage_id" uuid,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"state" text NOT NULL,
	"removal_note" text,
	"orphan_alerted_at" timestamp(3) with time zone,
	CONSTRAINT "folder_kind_check" CHECK (kind IN ('service', 'volume')),
	CONSTRAINT "folder_state_check" CHECK (state IN ('planned', 'present', 'removing', 'orphan', 'missing')),
	CONSTRAINT "folder_removal_note_check" CHECK (removal_note IS NULL OR char_length(removal_note) <= 300),
	CONSTRAINT "folder_slug_check" CHECK (slug ~ '^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$' AND slug !~ '\.\.'),
	CONSTRAINT "folder_scope_check" CHECK (scope = 'common' OR (scope ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND scope NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging', 'base'))),
	CONSTRAINT "folder_common_scope_check" CHECK ((scope = 'common' AND environment_id IS NULL) OR (scope <> 'common' AND (environment_id IS NOT NULL OR state IN ('orphan', 'removing')))),
	CONSTRAINT "folder_asset_kind_check" CHECK ((kind = 'service' AND storage_id IS NULL) OR (kind = 'volume' AND service_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "forge" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"name" varchar(255) NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"api_url" text,
	"external_app_id" text NOT NULL,
	"app_slug" varchar(255),
	"client_id" text,
	"redirect_uri" text,
	"webhook_origin" text,
	"custom_git_user" varchar(64),
	"custom_git_port" integer,
	"synced_at" timestamp(3) with time zone,
	"envelopes" jsonb NOT NULL,
	"webhook_ref" varchar(64) NOT NULL,
	"webhook_token_hash" text,
	"is_public" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "ingress" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"account_id" text,
	"zone_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_envelope" text NOT NULL,
	"scopes" jsonb,
	"last_verified_at" timestamp(3) with time zone,
	"last_error" text,
	CONSTRAINT "ingress_provider_check" CHECK (provider IN ('cloudflare', 'bunny'))
);
--> statement-breakpoint
CREATE TABLE "origin" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"uploaded_cert_id" uuid,
	"ingress_id" uuid,
	"host" text NOT NULL,
	"source" text NOT NULL,
	"acme_last_attempt_at" timestamp(3) with time zone,
	"acme_last_error" text,
	"not_after" timestamp(3) with time zone,
	"mode" text DEFAULT 'direct' NOT NULL,
	"public_port" integer DEFAULT 8443 NOT NULL,
	"ingress_state" jsonb,
	"acme_state" jsonb,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_daemon_dial" boolean DEFAULT true NOT NULL,
	CONSTRAINT "origin_host_unique" UNIQUE("host"),
	CONSTRAINT "origin_mode_check" CHECK (mode IN ('direct', 'lan-only', 'cloudflare-tunnel', 'cloudflare-proxy', 'bunny-proxy', 'private-overlay', 'passthrough')),
	CONSTRAINT "origin_public_port_check" CHECK (public_port BETWEEN 1 AND 65535),
	CONSTRAINT "origin_source_check" CHECK (source IN ('platform-ca', 'uploaded', 'acme-http-01', 'acme-dns-01')),
	CONSTRAINT "origin_uploaded_cert_check" CHECK ((source <> 'uploaded') OR (uploaded_cert_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "certificate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'uploaded' NOT NULL,
	"label" text NOT NULL,
	"cert_pem" text NOT NULL,
	"key_pem" text NOT NULL,
	"dns_names" jsonb NOT NULL,
	"not_after" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "certificate_kind_check" CHECK (kind IN ('uploaded', 'acme-dns-01'))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"email" varchar(255) NOT NULL,
	"grants" jsonb,
	"token_hash" text NOT NULL,
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
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"managed_id" uuid,
	"replica_id" uuid,
	"ca_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ca_generation" integer NOT NULL,
	"not_after" timestamp(3) with time zone NOT NULL,
	"issued_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"stale_at" timestamp(3) with time zone,
	"stale_reason" text,
	"stale_cause" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp(3) with time zone,
	"last_error" text,
	CONSTRAINT "leaf_kind_check" CHECK (kind IN ('ingress','engine','peer')),
	CONSTRAINT "leaf_state_check" CHECK (state IN ('active','stale')),
	CONSTRAINT "leaf_stale_cause_check" CHECK (stale_cause IS NULL OR stale_cause IN ('offline','unused','owner')),
	CONSTRAINT "leaf_stale_check" CHECK (("leaf"."state" = 'stale') = ("leaf"."stale_at" IS NOT NULL) AND ("leaf"."state" = 'stale') = ("leaf"."stale_cause" IS NOT NULL)),
	CONSTRAINT "leaf_attempts_check" CHECK ("leaf"."attempts" >= 0),
	CONSTRAINT "leaf_text_length_check" CHECK (("leaf"."stale_reason" IS NULL OR length("leaf"."stale_reason") <= 300) AND ("leaf"."last_error" IS NULL OR length("leaf"."last_error") <= 300)),
	CONSTRAINT "leaf_kind_keys_check" CHECK ((
        ("leaf"."kind" IN ('ingress','peer') AND "leaf"."replica_id" IS NULL AND "leaf"."managed_id" IS NULL)
        OR
        ("leaf"."kind" = 'engine' AND "leaf"."replica_id" IS NOT NULL AND "leaf"."managed_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "lease" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"name" text NOT NULL,
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
	"tier_id" uuid,
	"name" text,
	"token" text,
	"revoked_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "login" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"managed_id" uuid NOT NULL,
	"principal_id" uuid,
	"role" text NOT NULL,
	"username" varchar(255) NOT NULL,
	"applied_username" varchar(255) NOT NULL,
	"name_scheme" text DEFAULT 'plain' NOT NULL,
	"password" text,
	"grant_mode" text DEFAULT 'recipe' NOT NULL,
	"recipe" text,
	"allowed_sources" text[] DEFAULT '{internal}'::text[] NOT NULL,
	"max_connections" integer,
	"access" text DEFAULT 'read-write' NOT NULL,
	"privileges" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_all_databases" boolean DEFAULT false NOT NULL,
	"is_tool" boolean DEFAULT false NOT NULL,
	"is_straight_through" boolean,
	CONSTRAINT "login_role_check" CHECK (role IN ('root', 'replication', 'user', 'backup')),
	CONSTRAINT "login_name_scheme_check" CHECK (name_scheme IN ('plain', 'partial', 'random')),
	CONSTRAINT "login_grant_mode_check" CHECK (grant_mode IN ('recipe', 'self')),
	CONSTRAINT "login_recipe_check" CHECK (recipe IS NULL OR recipe IN ('app', 'migrations', 'read-only', 'analyst', 'admin', 'backup')),
	CONSTRAINT "login_recipe_required_check" CHECK (grant_mode <> 'recipe' OR recipe IS NOT NULL),
	CONSTRAINT "login_allowed_sources_check" CHECK (cardinality(allowed_sources) BETWEEN 1 AND 100),
	CONSTRAINT "login_backup_sources_check" CHECK (role <> 'backup' OR cardinality(allowed_sources) >= 1),
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
	"status" text DEFAULT 'provisioning' NOT NULL,
	"engine" text NOT NULL,
	"backup_destination" text,
	CONSTRAINT "managed_backup_destination_check" CHECK (backup_destination IS NULL OR backup_destination = 'none' OR backup_destination ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
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
	"owner_login_id" uuid,
	"name" varchar(255) NOT NULL,
	"is_role_owned" boolean DEFAULT false NOT NULL,
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
	"name" varchar(255),
	"kind" text NOT NULL,
	"cidr" "cidr",
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
CREATE TABLE "nonce" (
	"value" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "nonce_kind_check" CHECK (kind IN ('challenge', 'request'))
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid NOT NULL,
	"topic_code" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"target_type" text,
	"target_id" uuid,
	"context" jsonb,
	"read_at" timestamp(3) with time zone,
	"dismissed_at" timestamp(3) with time zone,
	"event_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"destination_id" uuid,
	CONSTRAINT "uniq_notification_event_user" UNIQUE("event_id","user_id"),
	CONSTRAINT "notification_severity_check" CHECK (severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "category" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "category_code_check" CHECK (code ~ '^[a-z][a-z_]{1,39}$')
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"created_by_user_id" uuid,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"signing_secret" text,
	"verified_at" timestamp(3) with time zone,
	"disabled_at" timestamp(3) with time zone,
	"digest_cadence" text,
	"quiet_start_minute" smallint,
	"quiet_end_minute" smallint,
	"failures" integer DEFAULT 0 NOT NULL,
	"paused_reason" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_all_organizations_notified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "channel_scope_check" CHECK (scope IN ('instance', 'organization', 'user')),
	CONSTRAINT "channel_kind_check" CHECK (kind IN ('email', 'webhook', 'slack', 'discord', 'telegram', 'push')),
	CONSTRAINT "channel_owner_check" CHECK ((scope = 'instance' AND organization_id IS NULL AND user_id IS NULL) OR (scope = 'organization' AND organization_id IS NOT NULL AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)),
	CONSTRAINT "channel_digest_cadence_check" CHECK (digest_cadence IS NULL OR digest_cadence IN ('hourly', 'daily')),
	CONSTRAINT "channel_quiet_hours_check" CHECK ((quiet_start_minute IS NULL AND quiet_end_minute IS NULL) OR (quiet_start_minute BETWEEN 0 AND 1439 AND quiet_end_minute BETWEEN 0 AND 1439 AND quiet_start_minute <> quiet_end_minute)),
	CONSTRAINT "channel_paused_reason_check" CHECK (paused_reason IS NULL OR paused_reason IN ('manual', 'failing', 'bounced')),
	CONSTRAINT "channel_primary_check" CHECK (NOT is_primary OR (scope = 'user' AND kind = 'email')),
	CONSTRAINT "channel_all_organizations_check" CHECK (NOT is_all_organizations_notified OR scope = 'instance')
);
--> statement-breakpoint
CREATE TABLE "attempt" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"channel_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"device_id" uuid,
	"topic_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp(3) with time zone,
	"sent_at" timestamp(3) with time zone,
	"last_error" text,
	"reason" text,
	"provider_id" text,
	CONSTRAINT "attempt_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "attempt_status_check" CHECK (status IN ('pending', 'sent', 'failed', 'abandoned', 'held', 'suppressed')),
	CONSTRAINT "attempt_reason_check" CHECK (reason IS NULL OR reason IN ('quiet_hours', 'digest', 'muted', 'rate_limited', 'bounced', 'no_access', 'scope_deleted', 'read_in_app', 'unverified', 'channel_failing'))
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text NOT NULL,
	"token" text NOT NULL,
	"token_hash" text NOT NULL,
	"app_version" text,
	"locale" text,
	"invalid_reason" text,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_device_provider_token_hash" UNIQUE("provider","token_hash"),
	CONSTRAINT "device_kind_check" CHECK (kind IN ('ios', 'android')),
	CONSTRAINT "device_status_check" CHECK (status IN ('active', 'paused', 'invalid')),
	CONSTRAINT "device_provider_check" CHECK (provider IN ('expo'))
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"topic_code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"destination_id" uuid,
	"actor_user_id" uuid,
	"severity" text NOT NULL,
	"dedupe" text,
	"version" integer DEFAULT 1 NOT NULL,
	"repeats" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"fanned_out_at" timestamp(3) with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "event_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "event_status_check" CHECK (status IN ('open', 'resolved', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "policy" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid,
	"project_id" uuid,
	"environment_id" uuid,
	"category_code" text,
	"topic_code" text,
	"created_by_user_id" uuid,
	"kind" text,
	"level" text NOT NULL,
	"is_forced" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_policy_scope" UNIQUE NULLS NOT DISTINCT("organization_id","team_id","project_id","environment_id","category_code","topic_code","kind"),
	CONSTRAINT "policy_kind_check" CHECK (kind IS NULL OR kind IN ('inbox', 'email', 'push', 'chat', 'webhook')),
	CONSTRAINT "policy_level_check" CHECK (level IN ('all', 'warning', 'critical', 'none')),
	CONSTRAINT "policy_env_project_check" CHECK (environment_id IS NULL OR project_id IS NOT NULL),
	CONSTRAINT "policy_subject_check" CHECK (num_nonnulls(category_code, topic_code) <= 1)
);
--> statement-breakpoint
CREATE TABLE "preference" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"destination_id" uuid,
	"channel_id" uuid,
	"category_code" text,
	"topic_code" text,
	"kind" text,
	"ends_at" timestamp(3) with time zone,
	"level" text NOT NULL,
	CONSTRAINT "uniq_preference_scope" UNIQUE NULLS NOT DISTINCT("user_id","organization_id","project_id","environment_id","service_id","server_id","destination_id","category_code","topic_code","kind","channel_id"),
	CONSTRAINT "preference_kind_check" CHECK (kind IS NULL OR kind IN ('inbox', 'email', 'push', 'chat', 'webhook')),
	CONSTRAINT "preference_level_check" CHECK (level IN ('all', 'warning', 'critical', 'none')),
	CONSTRAINT "preference_project_org_check" CHECK (project_id IS NULL OR organization_id IS NOT NULL),
	CONSTRAINT "preference_env_project_check" CHECK (environment_id IS NULL OR project_id IS NOT NULL),
	CONSTRAINT "preference_resource_one_check" CHECK (num_nonnulls(service_id, server_id, destination_id) <= 1),
	CONSTRAINT "preference_resource_org_check" CHECK (num_nonnulls(service_id, server_id, destination_id) = 0 OR organization_id IS NOT NULL),
	CONSTRAINT "preference_subject_check" CHECK (num_nonnulls(category_code, topic_code) <= 1),
	CONSTRAINT "preference_target_check" CHECK (num_nonnulls(channel_id, kind) <= 1)
);
--> statement-breakpoint
CREATE TABLE "rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"channel_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"service_id" uuid,
	"server_id" uuid,
	"destination_id" uuid,
	"category_code" text,
	"topic_code" text,
	"min_severity" text DEFAULT 'info' NOT NULL,
	"ends_at" timestamp(3) with time zone,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uniq_rule_scope" UNIQUE NULLS NOT DISTINCT("channel_id","organization_id","project_id","environment_id","service_id","server_id","destination_id","category_code","topic_code"),
	CONSTRAINT "rule_min_severity_check" CHECK (min_severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "rule_project_org_check" CHECK (project_id IS NULL OR organization_id IS NOT NULL),
	CONSTRAINT "rule_env_project_check" CHECK (environment_id IS NULL OR project_id IS NOT NULL),
	CONSTRAINT "rule_resource_one_check" CHECK (num_nonnulls(service_id, server_id, destination_id) <= 1),
	CONSTRAINT "rule_resource_org_check" CHECK (num_nonnulls(service_id, server_id, destination_id) = 0 OR organization_id IS NOT NULL),
	CONSTRAINT "rule_subject_check" CHECK (num_nonnulls(category_code, topic_code) <= 1)
);
--> statement-breakpoint
CREATE TABLE "suppression" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"address_hash" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"cleared_at" timestamp(3) with time zone,
	CONSTRAINT "suppression_reason_check" CHECK (reason IN ('bounced', 'complained', 'rejected')),
	CONSTRAINT "suppression_source_check" CHECK (source IN ('smtp', 'mailgun', 'mailpit', 'manual')),
	CONSTRAINT "suppression_address_hash_check" CHECK (address_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "topic" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"category_code" text NOT NULL,
	"resolves_code" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"scope" text,
	"audience" text NOT NULL,
	"channels" text[] NOT NULL,
	"level" text DEFAULT 'none' NOT NULL,
	"cooldown" interval DEFAULT '00:00:00' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deprecated_at" timestamp(3) with time zone,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"is_actor_notified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "topic_code_check" CHECK (code ~ '^[a-z][a-z_]*[.][a-z][a-z_]*$'),
	CONSTRAINT "topic_kind_check" CHECK (kind IN ('organization', 'platform', 'instance', 'account')),
	CONSTRAINT "topic_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "topic_scope_check" CHECK (scope IS NULL OR scope IN ('organization', 'project', 'environment', 'service', 'server', 'destination')),
	CONSTRAINT "topic_scope_kind_check" CHECK ((kind = 'organization') = (scope IS NOT NULL)),
	CONSTRAINT "topic_audience_check" CHECK (audience IN ('members', 'managers', 'admins')),
	CONSTRAINT "topic_channels_check" CHECK (channels <@ ARRAY['inbox', 'email', 'push', 'chat', 'webhook']::text[]),
	CONSTRAINT "topic_level_check" CHECK (level IN ('all', 'warning', 'critical', 'none'))
);
--> statement-breakpoint
CREATE TABLE "watermark" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"user_id" uuid NOT NULL,
	"read_through" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "uniq_watermark_user_organization" UNIQUE NULLS NOT DISTINCT("user_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"options" jsonb,
	"backup_destination_id" uuid,
	"name" text,
	"next_linux_id" integer DEFAULT 30001 NOT NULL,
	"deploy_timeout_minutes" integer,
	"acme_contact_email" text,
	"acme_terms_accepted_at" timestamp(3) with time zone,
	"acme_terms_url" text,
	"icon" text,
	"is_acme_enabled" boolean DEFAULT false NOT NULL,
	"is_emoji_icon_allowed" boolean DEFAULT true NOT NULL,
	CONSTRAINT "organization_next_linux_id_check" CHECK ("organization"."next_linux_id" >= 30001 AND "organization"."next_linux_id" <= 60001),
	CONSTRAINT "organization_deploy_timeout_minutes_check" CHECK ("organization"."deploy_timeout_minutes" IS NULL OR ("organization"."deploy_timeout_minutes" >= 5 AND "organization"."deploy_timeout_minutes" <= 240)),
	CONSTRAINT "organization_acme_terms_check" CHECK (("organization"."acme_terms_accepted_at" IS NULL) = ("organization"."acme_terms_url" IS NULL) AND ("organization"."acme_terms_url" IS NULL OR ("organization"."acme_terms_url" LIKE 'https://%' AND char_length("organization"."acme_terms_url") <= 2048))),
	CONSTRAINT "organization_icon_check" CHECK (icon IS NULL OR icon IN ('cube', 'globe', 'cart', 'bolt', 'chat', 'chart', 'code', 'book', 'layers', 'mail', 'rocket', 'image') OR (char_length(icon) BETWEEN 1 AND 16 AND icon !~ '[[:ascii:]]')),
	CONSTRAINT "organization_acme_contact_email_check" CHECK ("organization"."acme_contact_email" IS NULL OR (char_length("organization"."acme_contact_email") >= 3 AND char_length("organization"."acme_contact_email") <= 254 AND "organization"."acme_contact_email" LIKE '%_@_%'))
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"aaguid" text,
	"public_key" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"device_type" varchar(32) NOT NULL,
	"transports" text,
	"is_backed_up" boolean NOT NULL,
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
CREATE TABLE "peak" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"bucket" timestamp(3) with time zone NOT NULL,
	"memory_bytes" bigint,
	"cores" integer,
	CONSTRAINT "peak_memory_bytes_check" CHECK (memory_bytes >= 0),
	CONSTRAINT "peak_cores_check" CHECK (cores >= 0),
	CONSTRAINT "peak_reading_check" CHECK (memory_bytes IS NOT NULL OR cores IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "peripheral" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"service_id" uuid,
	"name" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'present' NOT NULL,
	"path" text NOT NULL,
	"vendor_id" text,
	"product_id" text,
	"observed_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_peripheral_server_path" UNIQUE("server_id","path"),
	CONSTRAINT "peripheral_kind_check" CHECK (kind IN ('usb', 'serial', 'printer', 'video', 'audio', 'other')),
	CONSTRAINT "peripheral_status_check" CHECK (status IN ('present', 'missing')),
	CONSTRAINT "peripheral_path_check" CHECK (path ~ '^/dev/[A-Za-z0-9._:/+-]+$' AND path !~ '\.\.'),
	CONSTRAINT "peripheral_vendor_id_check" CHECK (vendor_id IS NULL OR vendor_id ~ '^[0-9a-f]{4}$'),
	CONSTRAINT "peripheral_product_id_check" CHECK (product_id IS NULL OR product_id ~ '^[0-9a-f]{4}$')
);
--> statement-breakpoint
CREATE TABLE "portal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"tunnel_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"wanted" text DEFAULT 'run' NOT NULL,
	"reported" text DEFAULT 'unknown' NOT NULL,
	"last_seen_at" timestamp(3) with time zone,
	"last_error" text,
	"connector_version" text,
	"version_checked_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_portal_tunnel_id_server_id" UNIQUE("tunnel_id","server_id"),
	CONSTRAINT "portal_wanted_check" CHECK (wanted IN ('run', 'skip')),
	CONSTRAINT "portal_reported_check" CHECK (reported IN ('unknown', 'connected', 'down', 'error'))
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"access" text DEFAULT 'sftp' NOT NULL,
	"username" varchar(255) NOT NULL,
	"applied_username" varchar(255) NOT NULL,
	"password" text,
	"removal_requested_at" timestamp(3) with time zone,
	CONSTRAINT "principal_access_check" CHECK (access IN ('none', 'sftp', 'shell')),
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
	"sync_device_id" text,
	"sync_port" integer,
	CONSTRAINT "uniq_placement_principal_server" UNIQUE("principal_id","server_id"),
	CONSTRAINT "placement_state_check" CHECK (state IN ('pending', 'present', 'retiring', 'absent')),
	CONSTRAINT "placement_source_check" CHECK (source IN ('compose', 'manual', 'storage')),
	CONSTRAINT "placement_sync_device_id_check" CHECK (sync_device_id IS NULL OR sync_device_id ~ '^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$'),
	CONSTRAINT "placement_sync_port_check" CHECK (sync_port IS NULL OR sync_port BETWEEN 1024 AND 65535)
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid,
	"default_server_id" uuid,
	"name" text,
	"slug" text DEFAULT uuidv7()::text NOT NULL,
	"kind" text,
	"description" text,
	"component" text,
	"icon" text,
	"template_code" text,
	"template_track" text,
	"template_version" text,
	"template_digest" text,
	CONSTRAINT "uniq_project_organization_slug" UNIQUE("organization_id","slug"),
	CONSTRAINT "uniq_project_organization_id" UNIQUE("organization_id","id"),
	CONSTRAINT "project_slug_check" CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
	CONSTRAINT "project_kind_check" CHECK (kind IS NULL OR kind IN ('compose', 'managed', 'system')),
	CONSTRAINT "project_template_stamp_check" CHECK ((template_code IS NULL AND template_track IS NULL AND template_version IS NULL AND template_digest IS NULL) OR (template_code IS NOT NULL AND template_track IS NOT NULL AND template_version IS NOT NULL AND template_digest IS NOT NULL)),
	CONSTRAINT "project_template_code_check" CHECK (template_code IS NULL OR template_code ~ '^[a-z][a-z0-9-]{0,63}$'),
	CONSTRAINT "project_template_track_check" CHECK (template_track IS NULL OR template_track ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
	CONSTRAINT "project_template_version_check" CHECK (template_version IS NULL OR template_version ~ '^[0-9]+[.][0-9]+[.][0-9]+$'),
	CONSTRAINT "project_template_digest_check" CHECK (template_digest IS NULL OR template_digest ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "project_icon_check" CHECK (icon IS NULL OR icon IN ('cube', 'globe', 'cart', 'bolt', 'chat', 'chart', 'code', 'book', 'layers', 'mail', 'rocket', 'image') OR (char_length(icon) BETWEEN 1 AND 16 AND icon !~ '[[:ascii:]]'))
);
--> statement-breakpoint
CREATE TABLE "recovery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"managed_id" uuid NOT NULL,
	"target_member_id" uuid,
	"kind" text NOT NULL,
	"source_primary_member_id" uuid NOT NULL,
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
	"kind" text DEFAULT 'server' NOT NULL,
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
	CONSTRAINT "relay_member_advertised_cidrs_empty_check" CHECK ("relay"."role" <> 'member' OR cardinality("relay"."advertised_cidrs") = 0),
	CONSTRAINT "relay_kind_check" CHECK (kind IN ('server', 'external'))
);
--> statement-breakpoint
CREATE TABLE "replica" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"managed_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"replica_class" text,
	"ordinal" integer DEFAULT 1 NOT NULL,
	"replication_transport" text,
	"private_port" integer,
	"is_read_eligible" boolean DEFAULT false NOT NULL,
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
	"managed_id" uuid,
	"copy_id" uuid,
	"created_by" uuid,
	"name" text NOT NULL,
	"target_kind" text NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text,
	"database" text,
	"retention_keep" integer NOT NULL,
	"next_run_at" timestamp(3) with time zone,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "retention_target_kind_check" CHECK (target_kind IN ('managed', 'copy')),
	CONSTRAINT "retention_target_check" CHECK ((target_kind = 'managed' AND managed_id IS NOT NULL AND copy_id IS NULL) OR (target_kind = 'copy' AND copy_id IS NOT NULL AND managed_id IS NULL)),
	CONSTRAINT "retention_retention_keep_check" CHECK (retention_keep BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "rotation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"approved_by_user_id" uuid,
	"kind" text NOT NULL,
	"keyset" integer NOT NULL,
	"state" text NOT NULL,
	"prev_kid" text NOT NULL,
	"current_kid" text NOT NULL,
	"body" text NOT NULL,
	"approvals" text NOT NULL,
	"prev_key" text,
	"prev_key_signature" text,
	"live_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_rotation_keyset" UNIQUE("keyset"),
	CONSTRAINT "rotation_kind_check" CHECK (kind IN ('rotate', 'revoke', 'passkeys')),
	CONSTRAINT "rotation_state_check" CHECK (state IN ('awaiting_key', 'live')),
	CONSTRAINT "rotation_live_at_check" CHECK ((state = 'live') = (live_at IS NOT NULL)),
	CONSTRAINT "rotation_prev_key_signature_check" CHECK ((prev_key IS NULL) = (prev_key_signature IS NULL))
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
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"secret_envelope" text NOT NULL,
	CONSTRAINT "secret_provider_check" CHECK (provider IN ('s3', 's3_compatible', 'nfs', 'cifs', 'sftp', 'ftp', 'webdav',
        'git_deploy_key', 'carrier_badge', 'tunnel_run'))
);
--> statement-breakpoint
CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid,
	"assigned_tier_id" uuid,
	"preferred_tier_id" uuid,
	"preferred_datacenter_id" uuid,
	"name" text,
	"role" text DEFAULT 'server' NOT NULL,
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
	"ntp_servers" jsonb,
	"ntp_last_synced_at" timestamp(3) with time zone,
	"status_changed_at" timestamp(3) with time zone,
	"daemon" jsonb,
	"sealing_key_kid" text,
	"sealing_key_pub" text,
	"sealing_key_reported_at" timestamp(3) with time zone,
	"plaintext_secrets_at" timestamp(3) with time zone,
	"fabric_role" text,
	"trust_pinned_by" text,
	"trust_level" smallint DEFAULT 0 NOT NULL,
	"trust_pin_fingerprint" text,
	"trust_pin_keyset" integer,
	"trust_pin_reported_at" timestamp (3) with time zone,
	"trust_pin_passkeys" text,
	"trust_silence_stage" smallint,
	"trust_silence_since" timestamp(3) with time zone,
	"trust_silence_alive_at" timestamp(3) with time zone,
	"trust_reports_signed_at" timestamp(3) with time zone,
	"container_prefix" "cidr",
	"hardware" jsonb,
	"capability" jsonb,
	"offline_reason" text,
	"daemon_commit" text,
	"daemon_built_at" timestamp(3) with time zone,
	"daemon_update_status" text,
	"external_access_pending_at" timestamp(3) with time zone,
	"is_time_sync_enabled" boolean,
	"is_connected" boolean DEFAULT false NOT NULL,
	"is_hosting_enabled" boolean,
	"is_fabric_enabled" boolean DEFAULT true NOT NULL,
	"is_trust_pin_matching" boolean,
	CONSTRAINT "uniq_server_machine_key" UNIQUE("machine_key"),
	CONSTRAINT "server_machine_class_check" CHECK ("server"."machine_class" IN ('physical', 'virtual')),
	CONSTRAINT "server_machine_class_source_check" CHECK (machine_class_source IN ('detected', 'operator')),
	CONSTRAINT "server_os_architecture_check" CHECK (os_architecture IS NULL OR os_architecture IN ('x86_64', 'aarch64')),
	CONSTRAINT "server_offline_reason_check" CHECK (offline_reason IN ('disconnect', 'sweep_stale')),
	CONSTRAINT "server_daemon_update_status_check" CHECK (daemon_update_status IN ('idle', 'updating', 'done', 'failed', 'expired')),
	CONSTRAINT "server_fabric_role_check" CHECK (fabric_role IS NULL OR fabric_role IN ('gateway', 'client')),
	CONSTRAINT "server_trust_pinned_by_check" CHECK (trust_pinned_by IS NULL OR trust_pinned_by IN ('install', 'upgrade', 'unsafe')),
	CONSTRAINT "server_trust_level_check" CHECK (trust_level BETWEEN 0 AND 2),
	CONSTRAINT "server_role_check" CHECK (role IN ('server', 'witness'))
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
	"slug" text,
	"description" text,
	"compose_service_name" varchar(255) NOT NULL,
	"is_common" boolean DEFAULT false NOT NULL,
	"is_host_access_allowed" boolean DEFAULT false NOT NULL,
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
	"status" text NOT NULL,
	"run_id" text NOT NULL,
	"started_at" timestamp(3) with time zone NOT NULL,
	"finished_at" timestamp(3) with time zone NOT NULL,
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
	"user_id" uuid,
	"name" text NOT NULL,
	"key_type" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"comment" text,
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
	"status" text DEFAULT 'pending' NOT NULL,
	"unit" text NOT NULL,
	"phase" text DEFAULT 'fleet' NOT NULL,
	"batch_index" integer DEFAULT 0 NOT NULL,
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
	"started_at" timestamp(3) with time zone,
	"finished_at" timestamp(3) with time zone,
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
	"principal_id" uuid,
	"name" varchar(255) NOT NULL,
	"slug" text,
	"kind" text NOT NULL,
	"access_mode" text DEFAULT 'single_writer' NOT NULL,
	"retention" text DEFAULT 'retain' NOT NULL,
	"content_envelope" text,
	"compose_volume_key" text,
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
	"status" text NOT NULL,
	"provider_subscription_id" text NOT NULL,
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
	"concurrency_policy" text DEFAULT 'forbid' NOT NULL,
	"timeout_seconds" integer,
	"is_enabled" boolean DEFAULT true NOT NULL,
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
CREATE TABLE "ticket" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"license_id" uuid,
	"server_id" uuid,
	"used_by_server_id" uuid,
	"created_by_user_id" uuid,
	"server_name" text,
	"token" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"used_at" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "tier" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"label" text NOT NULL,
	"rank" integer NOT NULL,
	"provider" text,
	"provider_product_id" text,
	"price_cents" integer,
	"currency" text,
	"is_custom" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tier_provider_check" CHECK (provider IN ('stripe')),
	CONSTRAINT "tier_provider_bound_check" CHECK (provider_product_id IS NULL OR provider IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"issued_by_server_id" uuid,
	"name" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"source" text NOT NULL,
	"certificate_pem" text,
	"private_key_pem" text,
	"not_after" timestamp(3) with time zone,
	"fingerprint_sha256" text,
	"ca_state" text,
	"ca_generation" integer,
	CONSTRAINT "tls_source_check" CHECK (source IN ('upload', 'lets_encrypt', 'self_signed', 'organization_ca', 'provider_origin')),
	CONSTRAINT "tls_name_format_check" CHECK ((name IS NULL) OR (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 255)) AND ((name)::text ~ '^[A-Za-z0-9 ._-]+$'::text))),
	CONSTRAINT "tls_ca_state_check" CHECK (ca_state IS NULL OR ca_state IN ('active', 'retired', 'revoked')),
	CONSTRAINT "tls_ca_lifecycle_source_check" CHECK ((source = 'organization_ca' AND ca_state IS NOT NULL) OR (source <> 'organization_ca' AND ca_state IS NULL AND ca_generation IS NULL)),
	CONSTRAINT "tls_ca_generation_source_check" CHECK (ca_generation IS NULL OR source = 'organization_ca'),
	CONSTRAINT "tls_ca_generation_required_check" CHECK (ca_state IS NULL OR ca_state = 'revoked' OR ca_generation IS NOT NULL),
	CONSTRAINT "tls_status_check" CHECK (status IN ('ready', 'pending', 'expired', 'failed', 'revoked', 'automatic'))
);
--> statement-breakpoint
CREATE TABLE "tunnel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"options" jsonb,
	"organization_id" uuid NOT NULL,
	"routing_organization_id" uuid NOT NULL,
	"carrier_id" uuid,
	"datacenter_id" uuid,
	"secret_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"placement" text DEFAULT 'chosen' NOT NULL,
	CONSTRAINT "uniq_tunnel_organization_id_name" UNIQUE("organization_id","name"),
	CONSTRAINT "uniq_tunnel_carrier_id_external_id" UNIQUE("carrier_id","external_id"),
	CONSTRAINT "tunnel_name_check" CHECK (char_length(name) BETWEEN 1 AND 64),
	CONSTRAINT "tunnel_all_datacenter_check" CHECK (placement <> 'all' OR datacenter_id IS NOT NULL),
	CONSTRAINT "tunnel_provider_check" CHECK (provider IN ('cloudflare')),
	CONSTRAINT "tunnel_placement_check" CHECK (placement IN ('one', 'chosen', 'all')),
	CONSTRAINT "tunnel_status_check" CHECK (status IN ('pending', 'active', 'attention', 'removing'))
);
--> statement-breakpoint
CREATE TABLE "totp" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "uniq_totp_user_id" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "upgrade" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"started_by" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"target" jsonb,
	"preflight" jsonb,
	"source" text NOT NULL,
	"channel" text NOT NULL,
	"phase" text,
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
	"role" text DEFAULT 'user' NOT NULL,
	"time_zone" varchar(64),
	"is_email_verified" boolean DEFAULT false NOT NULL,
	"is_2fa_enabled" boolean DEFAULT false NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"is_all_organizations_notified" boolean DEFAULT false NOT NULL,
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
	"description" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"is_literal" boolean DEFAULT false NOT NULL,
	"is_for_build" boolean DEFAULT false NOT NULL,
	"is_for_runtime" boolean DEFAULT true NOT NULL,
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
CREATE TABLE "visitor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	CONSTRAINT "uniq_visitor_service_name" UNIQUE("service_id","name"),
	CONSTRAINT "visitor_name_check" CHECK (name ~ '^[A-Za-z0-9._@-]{1,64}$'),
	CONSTRAINT "visitor_password_hash_check" CHECK (password_hash ~ '^\$2[aby]\$1[0-2]\$[./A-Za-z0-9]{53}$')
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
	"kind" varchar(32) DEFAULT 'user' NOT NULL,
	"description" text,
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
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_managed_id_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge" ADD CONSTRAINT "badge_carrier_id_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carrier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge" ADD CONSTRAINT "badge_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_login_id_login_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."login"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulwark" ADD CONSTRAINT "bulwark_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "custodian" ADD CONSTRAINT "custodian_passkey_id_passkey_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."passkey"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datacenter" ADD CONSTRAINT "datacenter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_last_command_id_command_id_fk" FOREIGN KEY ("last_command_id") REFERENCES "public"."command"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch" ADD CONSTRAINT "dispatch_command_id_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_carrier_id_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carrier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record" ADD CONSTRAINT "record_ingress_id_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "public"."ingress"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorway" ADD CONSTRAINT "doorway_routing_organization_id_organization_id_fk" FOREIGN KEY ("routing_organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorway" ADD CONSTRAINT "doorway_tunnel_id_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorway" ADD CONSTRAINT "doorway_hosting_id_hosting_id_fk" FOREIGN KEY ("hosting_id") REFERENCES "public"."hosting"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "ingress" ADD CONSTRAINT "ingress_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_uploaded_cert_id_certificate_id_fk" FOREIGN KEY ("uploaded_cert_id") REFERENCES "public"."certificate"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_ingress_id_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "public"."ingress"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "license" ADD CONSTRAINT "license_tier_id_tier_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."tier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "notification" ADD CONSTRAINT "notification_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_environment_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."environment"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy" ADD CONSTRAINT "policy_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_environment_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."environment"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference" ADD CONSTRAINT "preference_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."project"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_environment_fk" FOREIGN KEY ("project_id","environment_id") REFERENCES "public"."environment"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_destination_id_destination_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destination"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_topic_code_topic_code_fk" FOREIGN KEY ("topic_code") REFERENCES "public"."topic"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic" ADD CONSTRAINT "topic_category_code_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."category"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic" ADD CONSTRAINT "topic_resolves_code_topic_code_fk" FOREIGN KEY ("resolves_code") REFERENCES "public"."topic"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watermark" ADD CONSTRAINT "watermark_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watermark" ADD CONSTRAINT "watermark_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_backup_destination_id_destination_id_fk" FOREIGN KEY ("backup_destination_id") REFERENCES "public"."destination"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peak" ADD CONSTRAINT "peak_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral" ADD CONSTRAINT "peripheral_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peripheral" ADD CONSTRAINT "peripheral_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal" ADD CONSTRAINT "portal_tunnel_id_tunnel_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal" ADD CONSTRAINT "portal_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "rotation" ADD CONSTRAINT "rotation_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_login_id_login_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."login"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope" ADD CONSTRAINT "scope_database_id_database_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."database"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_assigned_tier_id_tier_id_fk" FOREIGN KEY ("assigned_tier_id") REFERENCES "public"."tier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_preferred_tier_id_tier_id_fk" FOREIGN KEY ("preferred_tier_id") REFERENCES "public"."tier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_preferred_datacenter_id_datacenter_id_fk" FOREIGN KEY ("preferred_datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_license_id_license_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."license"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_used_by_server_id_server_id_fk" FOREIGN KEY ("used_by_server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_issued_by_server_id_server_id_fk" FOREIGN KEY ("issued_by_server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_routing_organization_id_organization_id_fk" FOREIGN KEY ("routing_organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_carrier_id_carrier_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carrier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_datacenter_id_datacenter_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "visitor" ADD CONSTRAINT "visitor_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE UNIQUE INDEX "uniq_shipment_managed_destination" ON "shipment" USING btree ("managed_id","backup_id","destination_id");--> statement-breakpoint
CREATE INDEX "idx_shipment_managed_id_backup_id" ON "shipment" USING btree ("managed_id","backup_id");--> statement-breakpoint
CREATE INDEX "idx_shipment_destination_id" ON "shipment" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "idx_shipment_server_id" ON "shipment" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_destination_organization_name" ON "destination" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_destination_created_by" ON "destination" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_badge_carrier_id" ON "badge" USING btree ("carrier_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_binding_database_id" ON "binding" USING btree ("database_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_binding_login_id" ON "binding" USING btree ("login_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_binding_service_engine_defaults" ON "binding" USING btree ("service_id") WHERE "binding"."is_emit_engine_defaults";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bulwark_server_id" ON "bulwark" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_cache_server_id" ON "cache" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_cache_principal_id" ON "cache" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cache_server_port" ON "cache" USING btree ("server_id","port") WHERE port IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_carrier_organization_id" ON "carrier" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
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
CREATE INDEX "idx_command_server_open" ON "command" USING btree ("server_id","created_at","id") WHERE "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running');--> statement-breakpoint
CREATE INDEX "idx_command_managed" ON "command" USING btree ("managed_id") WHERE "command"."managed_id" IS NOT NULL AND "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running');--> statement-breakpoint
CREATE INDEX "idx_command_feed" ON "command" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" IN ('environment.deploy', 'environment.lifecycle', 'environment.stop') AND "command"."status" IN ('queued', 'dispatching', 'sent', 'acked', 'running', 'failed', 'timed_out');--> statement-breakpoint
CREATE INDEX "idx_command_activity" ON "command" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" IN ('environment.deploy', 'environment.lifecycle', 'environment.stop');--> statement-breakpoint
CREATE INDEX "idx_command_server_id_name_created_at" ON "command" USING btree ("server_id","name","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_command_deploy" ON "command" USING btree ("environment_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "command"."name" = 'environment.deploy';--> statement-breakpoint
CREATE INDEX "idx_container_server_id" ON "container" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_container_status" ON "container" USING btree ("status" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_server_container_id" ON "container" USING btree ("server_id","container_id") WHERE container_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_service_role_ordinal" ON "container" USING btree ("service_id","role","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_custodian_marked_pkid" ON "custodian" USING btree ("pkid" text_ops) WHERE (unmarked_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_datacenter_organization_id" ON "datacenter" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deployment_server_id" ON "deployment" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deployment_last_command" ON "deployment" USING btree ("last_command_id") WHERE "deployment"."last_command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_dispatch_expires_at" ON "dispatch" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_record_provider_zone_external" ON "record" USING btree ("provider","zone_id","external_id") WHERE "record"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_record_carrier_id" ON "record" USING btree ("carrier_id") WHERE "record"."carrier_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_record_ingress_id" ON "record" USING btree ("ingress_id") WHERE "record"."ingress_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_record_open" ON "record" USING btree ("updated_at") WHERE "record"."status" <> 'synced';--> statement-breakpoint
CREATE INDEX "idx_doorway_hosting_id" ON "doorway" USING btree ("hosting_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_edict_organization_id" ON "edict" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_edict_server_id" ON "edict" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_edict_created_by" ON "edict" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_environment_project_primary" ON "environment" USING btree ("project_id" uuid_ops) WHERE "environment"."is_primary";--> statement-breakpoint
CREATE INDEX "idx_environment_project_id" ON "environment" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_server_id" ON "environment" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fabric_organization_id" ON "fabric" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_folder_location" ON "folder" USING btree ("server_id","principal_id","scope","kind","slug");--> statement-breakpoint
CREATE INDEX "idx_folder_principal_id" ON "folder" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_environment_id" ON "folder" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_service_id" ON "folder" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_storage_id" ON "folder" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_folder_orphan_unalerted" ON "folder" USING btree ("server_id" uuid_ops) WHERE "folder"."state" = 'orphan' AND "folder"."orphan_alerted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_folder_orphan_alerted" ON "folder" USING btree ("state" text_ops) WHERE "folder"."orphan_alerted_at" IS NOT NULL;--> statement-breakpoint
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
CREATE INDEX "idx_origin_ingress_id" ON "origin" USING btree ("ingress_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_origin_primary" ON "origin" USING btree ("is_primary") WHERE is_primary;--> statement-breakpoint
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
CREATE UNIQUE INDEX "uniq_leaf_peer_server" ON "leaf" USING btree ("server_id") WHERE "leaf"."kind" = 'peer';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leaf_engine_replica" ON "leaf" USING btree ("replica_id") WHERE "leaf"."kind" = 'engine';--> statement-breakpoint
CREATE INDEX "idx_leaf_replica_id" ON "leaf" USING btree ("replica_id");--> statement-breakpoint
CREATE INDEX "idx_lease_organization_id" ON "lease" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_license_organization_id" ON "license" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_license_server_id" ON "license" USING btree ("server_id") WHERE "license"."server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_license_server_id" ON "license" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_license_tier_id" ON "license" USING btree ("tier_id");--> statement-breakpoint
CREATE INDEX "idx_login_principal_id" ON "login" USING btree ("principal_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_principal" ON "login" USING btree ("managed_id","principal_id") WHERE "login"."principal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_applied_username" ON "login" USING btree ("managed_id",lower(btrim(("applied_username")::text)));--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_login_managed_backup" ON "login" USING btree ("managed_id") WHERE "login"."role" = 'backup';--> statement-breakpoint
CREATE INDEX "idx_managed_backup_destination" ON "managed" USING btree ("backup_destination");--> statement-breakpoint
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
CREATE INDEX "idx_nonce_expires_at" ON "nonce" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_notification_user_created" ON "notification" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notification_unread" ON "notification" USING btree ("user_id") WHERE "notification"."read_at" IS NULL AND "notification"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notification_organization_id" ON "notification" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_notification_created_at" ON "notification" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_topic_code" ON "notification" USING btree ("topic_code");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_channel_primary" ON "channel" USING btree ("user_id","kind") WHERE is_primary;--> statement-breakpoint
CREATE INDEX "idx_channel_organization" ON "channel" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_channel_user" ON "channel" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_channel_created_by_user_id" ON "channel" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_attempt_copy" ON "attempt" USING btree ("event_id",coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid),"channel_id",coalesce("device_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "idx_attempt_user_id" ON "attempt" USING btree ("user_id") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_attempt_device_id" ON "attempt" USING btree ("device_id") WHERE device_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_attempt_topic_code" ON "attempt" USING btree ("topic_code");--> statement-breakpoint
CREATE INDEX "idx_attempt_created_at" ON "attempt" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_attempt_pending" ON "attempt" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_attempt_held" ON "attempt" USING btree ("channel_id","created_at") WHERE status = 'held';--> statement-breakpoint
CREATE INDEX "idx_attempt_channel_created" ON "attempt" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_attempt_organization_id" ON "attempt" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_device_user_id" ON "device" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_event_open_dedupe" ON "event" USING btree ("dedupe") WHERE status = 'open' AND dedupe IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_event_unfanned" ON "event" USING btree ("created_at") WHERE fanned_out_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_event_created_at" ON "event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_event_organization_id" ON "event" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_event_topic_code" ON "event" USING btree ("topic_code");--> statement-breakpoint
CREATE INDEX "idx_policy_team_id" ON "policy" USING btree ("team_id") WHERE team_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_project_id" ON "policy" USING btree ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_environment_id" ON "policy" USING btree ("environment_id") WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_category_code" ON "policy" USING btree ("category_code") WHERE category_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_topic_code" ON "policy" USING btree ("topic_code") WHERE topic_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_policy_created_by_user_id" ON "policy" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_preference_user_organization" ON "preference" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "idx_preference_organization_id" ON "preference" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_preference_project_id" ON "preference" USING btree ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_environment_id" ON "preference" USING btree ("environment_id") WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_service_id" ON "preference" USING btree ("service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_server_id" ON "preference" USING btree ("server_id") WHERE server_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_destination_id" ON "preference" USING btree ("destination_id") WHERE destination_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_channel_id" ON "preference" USING btree ("channel_id") WHERE channel_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_category_code" ON "preference" USING btree ("category_code") WHERE category_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_preference_topic_code" ON "preference" USING btree ("topic_code") WHERE topic_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_organization_id" ON "rule" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_rule_project_id" ON "rule" USING btree ("project_id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_environment_id" ON "rule" USING btree ("environment_id") WHERE environment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_service_id" ON "rule" USING btree ("service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_server_id" ON "rule" USING btree ("server_id") WHERE server_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_destination_id" ON "rule" USING btree ("destination_id") WHERE destination_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_category_code" ON "rule" USING btree ("category_code") WHERE category_code IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rule_topic_code" ON "rule" USING btree ("topic_code") WHERE topic_code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_suppression_active_address" ON "suppression" USING btree ("address_hash") WHERE cleared_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_topic_category_code" ON "topic" USING btree ("category_code");--> statement-breakpoint
CREATE INDEX "idx_topic_resolves_code" ON "topic" USING btree ("resolves_code");--> statement-breakpoint
CREATE INDEX "idx_watermark_organization_id" ON "watermark" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_organization_backup_destination_id" ON "organization" USING btree ("backup_destination_id");--> statement-breakpoint
CREATE INDEX "idx_passkey_user_id" ON "passkey" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_payer_organization_id" ON "payer" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_payer_user_id" ON "payer" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payer_provider_customer" ON "payer" USING btree ("provider","provider_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payer_organization_provider" ON "payer" USING btree ("organization_id","provider") WHERE "payer"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payer_user_provider" ON "payer" USING btree ("user_id","provider") WHERE "payer"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_peak_server_bucket" ON "peak" USING btree ("server_id","bucket");--> statement-breakpoint
CREATE INDEX "idx_peak_bucket" ON "peak" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "idx_peripheral_service_id" ON "peripheral" USING btree ("service_id") WHERE "peripheral"."service_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_portal_server_id" ON "portal" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_organization_id" ON "principal" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_principal_project_id" ON "principal" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_username" ON "principal" USING btree ("organization_id",lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_principal_organization_applied_username" ON "principal" USING btree ("organization_id",lower("applied_username"));--> statement-breakpoint
CREATE INDEX "idx_placement_server_id" ON "placement" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_placement_server_uid" ON "placement" USING btree ("server_id","uid") WHERE "placement"."uid" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_placement_server_sync_port" ON "placement" USING btree ("server_id","sync_port") WHERE "placement"."sync_port" IS NOT NULL;--> statement-breakpoint
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
CREATE INDEX "idx_server_preferred_datacenter_id" ON "server" USING btree ("preferred_datacenter_id" uuid_ops);--> statement-breakpoint
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
CREATE INDEX "idx_stage_upgrade_server" ON "stage" USING btree ("upgrade_id","server_id");--> statement-breakpoint
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
CREATE INDEX "idx_ticket_organization_id" ON "ticket" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_license_id" ON "ticket" USING btree ("license_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_server_id" ON "ticket" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tier_label" ON "tier" USING btree ("label");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tier_rank" ON "tier" USING btree ("rank");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tier_provider_product" ON "tier" USING btree ("provider","provider_product_id") WHERE "tier"."provider_product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_tls_issued_by_server_id" ON "tls" USING btree ("issued_by_server_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tls_organization_id" ON "tls" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tls_not_after" ON "tls" USING btree ("not_after" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tls_organization_fingerprint_sha256" ON "tls" USING btree ("organization_id","fingerprint_sha256") WHERE "tls"."fingerprint_sha256" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tls_organization_active_ca" ON "tls" USING btree ("organization_id") WHERE "tls"."source" = 'organization_ca' AND "tls"."ca_state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_tls_organization_ca_generation" ON "tls" USING btree ("organization_id","ca_generation") WHERE "tls"."source" = 'organization_ca';--> statement-breakpoint
CREATE INDEX "idx_tunnel_routing_organization_id" ON "tunnel" USING btree ("routing_organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tunnel_carrier_id" ON "tunnel" USING btree ("carrier_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tunnel_datacenter_id" ON "tunnel" USING btree ("datacenter_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_upgrade_active" ON "upgrade" USING btree ((true)) WHERE "upgrade"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_upgrade_started_by" ON "upgrade" USING btree ("started_by");--> statement-breakpoint
CREATE INDEX "idx_upgrade_created_at" ON "upgrade" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
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