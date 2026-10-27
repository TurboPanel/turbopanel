-- Update history pages by run and by server. Additive only: two nullable
-- step timestamps the store stamps from here on (rows written before stay
-- NULL and read as "not recorded"), an index for the run list (newest first)
-- and one for the per-server grouping of a run's steps. The previous release
-- never reads or writes the new columns.
ALTER TABLE "stage" ADD COLUMN "started_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "stage" ADD COLUMN "finished_at" timestamp(3) with time zone;--> statement-breakpoint
CREATE INDEX "idx_stage_upgrade_server" ON "stage" USING btree ("upgrade_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_upgrade_created_at" ON "upgrade" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
COMMENT ON COLUMN "stage"."started_at" IS 'When the step was first dispatched to its server; NULL until then, and on rows written before this column existed.';--> statement-breakpoint
COMMENT ON COLUMN "stage"."finished_at" IS 'When the step reached a terminal status (`done`, `skipped`, `failed`, `needs_attention`); cleared when a retry reopens it.';
