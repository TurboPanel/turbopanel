ALTER TABLE "stage" RENAME COLUMN "last_stage_at" TO "status_changed_at";--> statement-breakpoint
COMMENT ON COLUMN "stage"."status_changed_at" IS 'When `status` last changed, so a step stuck in one stage can be detected.';
