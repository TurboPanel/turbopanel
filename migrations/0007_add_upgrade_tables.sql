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
CREATE TABLE "upgradestep" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"upgrade_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"unit" text NOT NULL,
	"batch_index" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp(3) with time zone,
	"from_version" text,
	"to_version" text,
	"from_commit" text,
	"to_commit" text,
	"last_stage_at" timestamp(3) with time zone,
	"error_code" text,
	"error_message" text,
	"detail" jsonb,
	CONSTRAINT "upgradestep_unit_check" CHECK (unit IN ('daemon', 'instance')),
	CONSTRAINT "upgradestep_status_check" CHECK (status IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying', 'done', 'failed', 'rolled_back', 'needs_attention', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "upgrade" ADD CONSTRAINT "upgrade_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgradestep" ADD CONSTRAINT "upgradestep_upgrade_id_upgrade_id_fk" FOREIGN KEY ("upgrade_id") REFERENCES "public"."upgrade"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgradestep" ADD CONSTRAINT "upgradestep_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_upgrade_active" ON "upgrade" USING btree ((true)) WHERE "upgrade"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_upgradestep_upgrade_status" ON "upgradestep" USING btree ("upgrade_id","status");--> statement-breakpoint
CREATE INDEX "idx_upgradestep_server_created" ON "upgradestep" USING btree ("server_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_upgradestep_active_next_attempt" ON "upgradestep" USING btree ("status","next_attempt_at") WHERE "upgradestep"."status" IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying');
--> statement-breakpoint
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
COMMENT ON TABLE "upgradestep" IS 'One `daemon` or `instance` install on one server inside an upgrade run, advanced by the orchestrator until a terminal outcome.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."unit" IS '`daemon` or `instance`: the package this step installs on its server.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."batch_index" IS 'Zero-based wave index within the run; steps that share an index are dispatched together.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."status" IS '`pending`/`waiting`/`dispatched`/`preparing`/`downloading`/`installing`/`restarting`/`verifying`/`done`/`failed`/`rolled_back`/`needs_attention`/`skipped`.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."request_id" IS 'Cell correlation id for the in-flight install; NULL until the step is dispatched.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."attempts" IS 'Dispatch count for this step, starting at 0 and incremented before each retry.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."next_attempt_at" IS 'Earliest time a non-terminal step may be retried; NULL when no retry is scheduled.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."from_version" IS 'Version installed before this step ran; NULL when the host had none.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."to_version" IS 'Version this step installs, copied from the run target for `unit`.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."from_commit" IS 'Commit installed before this step ran; NULL when it was unknown.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."to_commit" IS 'Commit this step installs, copied from the run target for `unit`.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."last_stage_at" IS 'When `status` last changed, so a step stuck in one stage can be detected.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."error_code" IS 'Machine-readable code when the step fails, rolls back or needs attention.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."error_message" IS 'Human-readable failure text set alongside `error_code`.';--> statement-breakpoint
COMMENT ON COLUMN "upgradestep"."detail" IS 'Small stage facts such as bytes fetched or an exit code; the orchestrator writes it, never a transcript.';
