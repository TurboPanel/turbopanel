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
ALTER TABLE "placement" ADD CONSTRAINT "placement_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_placement_server_id" ON "placement" USING btree ("server_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_placement_server_uid" ON "placement" USING btree ("server_id","uid") WHERE "placement"."uid" IS NOT NULL;--> statement-breakpoint
-- Backfill from the implicit reach: a system principal exists on every server
-- its project's environments are pinned to or deployed on. Host ids stay NULL
-- until the daemon reports them.
INSERT INTO "placement" ("principal_id", "server_id", "state", "home", "source")
SELECT DISTINCT
	p."id",
	reach."server_id",
	'present',
	'/srv/users/' || p."applied_username",
	CASE WHEN p."metadata" ->> 'composeAlias' IS NOT NULL THEN 'compose' ELSE 'manual' END
FROM "principal" p
JOIN (
	SELECT e."project_id", e."server_id" FROM "environment" e WHERE e."server_id" IS NOT NULL
	UNION
	SELECT e."project_id", d."server_id" FROM "deployment" d JOIN "environment" e ON e."id" = d."environment_id"
) reach ON reach."project_id" = p."project_id"
WHERE p."kind" = 'system' AND p."provider" = 'server' AND p."project_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
COMMENT ON TABLE "placement" IS 'One system principal on one server, the per-server form of a `principal` row; written by deploy fan-out, teardown and server removal.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."state" IS '`pending` when a deploy that creates the account is queued, `present` once it succeeded, `retiring` once a stop that retires it is queued, `absent` after.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."uid" IS 'Linux uid the host assigned, reported by the daemon; NULL until then, unique per server when set.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."gid" IS 'Linux gid the host assigned, reported by the daemon; NULL until then.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."home" IS 'Account home on the host, `/srv/users/` plus the applied username, copied from the deploy material.';--> statement-breakpoint
COMMENT ON COLUMN "placement"."source" IS 'Why the account is on this server: `compose` (an `x-turbopanel.principals` alias), `manual` (a project principal), or `storage` (a storage entry owner).';
