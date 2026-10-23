-- breaking-ok: nothing is live before the fold, and the panel now normalises architecture on ingest
UPDATE "server" SET "os_architecture" = CASE
	WHEN lower(btrim("os_architecture")) IN ('x86_64', 'x86-64', 'amd64', 'x64') THEN 'x86_64'
	WHEN lower(btrim("os_architecture")) IN ('aarch64', 'arm64', 'armv8', 'armv8l', 'armv8a') THEN 'aarch64'
	ELSE NULL
END WHERE "os_architecture" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_os_architecture_check" CHECK (os_architecture IS NULL OR os_architecture IN ('x86_64', 'aarch64'));--> statement-breakpoint
COMMENT ON COLUMN "server"."os_architecture" IS 'Daemon-reported CPU architecture, normalised on ingest to `x86_64` or `aarch64` (`amd64` and `arm64` map across); other CPUs are not stored, so NULL.';--> statement-breakpoint
COMMENT ON COLUMN "server"."assigned_tier_id" IS 'Tier a manager assigned this server (license-tier route or a named size change); self-hosted fills the top tier when none. Never recomputed; NULL until set.';--> statement-breakpoint
COMMENT ON COLUMN "server"."preferred_tier_id" IS 'Written in step with `assigned_tier_id` by the manager route, for the console''s picked label; never read to place a server.';
