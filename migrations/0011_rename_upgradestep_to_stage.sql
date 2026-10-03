ALTER TABLE "upgradestep" RENAME TO "stage";--> statement-breakpoint
ALTER TABLE "stage" DROP CONSTRAINT "upgradestep_unit_check";--> statement-breakpoint
ALTER TABLE "stage" DROP CONSTRAINT "upgradestep_status_check";--> statement-breakpoint
ALTER TABLE "stage" DROP CONSTRAINT "upgradestep_upgrade_id_upgrade_id_fk";
--> statement-breakpoint
ALTER TABLE "stage" DROP CONSTRAINT "upgradestep_server_id_server_id_fk";
--> statement-breakpoint
DROP INDEX "idx_upgradestep_upgrade_status";--> statement-breakpoint
DROP INDEX "idx_upgradestep_server_created";--> statement-breakpoint
DROP INDEX "idx_upgradestep_active_next_attempt";--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_upgrade_id_upgrade_id_fk" FOREIGN KEY ("upgrade_id") REFERENCES "public"."upgrade"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_stage_upgrade_status" ON "stage" USING btree ("upgrade_id","status");--> statement-breakpoint
CREATE INDEX "idx_stage_server_created" ON "stage" USING btree ("server_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_stage_active_next_attempt" ON "stage" USING btree ("status","next_attempt_at") WHERE "stage"."status" IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying');--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_unit_check" CHECK (unit IN ('daemon', 'instance'));--> statement-breakpoint
ALTER TABLE "stage" ADD CONSTRAINT "stage_status_check" CHECK (status IN ('pending', 'waiting', 'dispatched', 'preparing', 'downloading', 'installing', 'restarting', 'verifying', 'done', 'failed', 'rolled_back', 'needs_attention', 'skipped'));
--> statement-breakpoint
COMMENT ON TABLE "stage" IS 'One `daemon` or `instance` install on one server inside an upgrade run, advanced by the orchestrator until a terminal outcome.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."unit" IS '`daemon` or `instance`: the package this step installs on its server.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."batch_index" IS 'Zero-based wave index within the run; steps that share an index are dispatched together.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."status" IS '`pending`/`waiting`/`dispatched`/`preparing`/`downloading`/`installing`/`restarting`/`verifying`/`done`/`failed`/`rolled_back`/`needs_attention`/`skipped`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."request_id" IS 'Cell correlation id for the in-flight install; NULL until the step is dispatched.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."attempts" IS 'Dispatch count for this step, starting at 0 and incremented before each retry.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."next_attempt_at" IS 'Earliest time a non-terminal step may be retried; NULL when no retry is scheduled.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."from_version" IS 'Version installed before this step ran; NULL when the host had none.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."to_version" IS 'Version this step installs, copied from the run target for `unit`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."from_commit" IS 'Commit installed before this step ran; NULL when it was unknown.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."to_commit" IS 'Commit this step installs, copied from the run target for `unit`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."last_stage_at" IS 'When `status` last changed, so a step stuck in one stage can be detected.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."error_code" IS 'Machine-readable code when the step fails, rolls back or needs attention.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."error_message" IS 'Human-readable failure text set alongside `error_code`.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."detail" IS 'Small stage facts such as bytes fetched or an exit code; the orchestrator writes it, never a transcript.';
