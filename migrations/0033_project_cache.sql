CREATE TABLE "cache" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"environment_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"name" varchar(63) NOT NULL,
	"engine" text DEFAULT 'valkey' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
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
ALTER TABLE "cache" ADD CONSTRAINT "cache_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache" ADD CONSTRAINT "cache_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cache_server_id" ON "cache" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_cache_principal_id" ON "cache" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cache_server_port" ON "cache" USING btree ("server_id","port") WHERE port IS NOT NULL;--> statement-breakpoint
COMMENT ON TABLE "cache" IS 'One native Valkey process per row, owned by one Hosting Account in one project environment on one server; the daemon runs it as that account.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."metadata" IS 'Last apply result from the daemon: `runtimeVersion`, `lastError` and `appliedAt`; written by the cache result handler only.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."principal_id" IS 'The Hosting Account the process runs as; only that account may reach it, and only its sites and apps get the variables.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."name" IS 'Short name unique in the environment, lower case letters, digits and dashes; shown in the web interface.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."engine" IS 'Engine binary: `valkey` today; `redis` is reserved for a later choice and refused by the API until it is offered.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."status" IS 'Last known state: `pending`, `applying`, `ready`, `stopped` or `failed`; written from apply results.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."version" IS 'Engine series such as `8.1`; the daemon maps it to the pinned patch release it vendors.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."access" IS '`socket` is a private unix socket only the account can open; `port` is a loopback port the host firewall opens to that account only.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."port" IS 'Loopback port from the server listen-port ledger, set only when `access` is `port`; unique per server.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."max_memory_mb" IS 'Data memory limit in MiB written as `maxmemory`; the unit memory ceiling is twice this plus 32 MiB.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."key_prefix" IS 'Prefix of the variable names delivered to the account sites and apps, for example `REDIS_HOST`; unique per account and environment.';--> statement-breakpoint
COMMENT ON COLUMN "cache"."password" IS 'Sealed `tpsecret` envelope of the login password; only its SHA-256 is sent to the daemon, the plain value travels as a sealed variable.';
