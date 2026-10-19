ALTER TABLE "changeover" ADD COLUMN "retire_by" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "stale_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "stale_cause" text;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "attempted_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_state_check" CHECK (state IN ('active','stale'));--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_stale_cause_check" CHECK (stale_cause IS NULL OR stale_cause IN ('offline','unused','owner'));--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_stale_check" CHECK (("leaf"."state" = 'stale') = ("leaf"."stale_at" IS NOT NULL) AND ("leaf"."state" = 'stale') = ("leaf"."stale_cause" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_attempts_check" CHECK ("leaf"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_text_length_check" CHECK (("leaf"."stale_reason" IS NULL OR length("leaf"."stale_reason") <= 300) AND ("leaf"."last_error" IS NULL OR length("leaf"."last_error") <= 300));--> statement-breakpoint
COMMENT ON COLUMN "changeover"."retire_by" IS 'Set when fan-out finishes: after it the sweep retires the previous CA generation once every live target converged; null before.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."state" IS '`active` (counted and renewed when due) or `stale` (nothing waits on it: not counted, not renewed, never holds back retiring the old CA).';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."stale_at" IS 'When the row was marked stale; set exactly when `state` is `stale`.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."stale_reason" IS 'Plain-words reason shown on the Organization CA card for a stale row (at most 300 characters).';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."stale_cause" IS '`offline` (server gone for weeks; comes back when it reconnects), `unused` (nothing needed it) or `owner`; set exactly when `state` is `stale`.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."attempts" IS 'Renewals tried since the leaf was last deployed; drives the retry back-off and resets on a successful deploy.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."attempted_at" IS 'When a renewal was last queued for this leaf; null before the first try.';--> statement-breakpoint
COMMENT ON COLUMN "leaf"."last_error" IS 'Plain-words reason the last renewal failed or could not be queued (at most 300 characters); cleared on a successful deploy.';
--> statement-breakpoint
UPDATE "changeover" SET "retire_by" = now() + interval '30 days' WHERE "state" = 'awaiting_retire' AND "retire_by" IS NULL;
