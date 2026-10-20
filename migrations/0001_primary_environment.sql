ALTER TABLE "environment" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "is_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "environment" SET "is_primary" = true WHERE "id" IN (SELECT DISTINCT ON ("project_id") "id" FROM "environment" ORDER BY "project_id", "created_at", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_environment_project_primary" ON "environment" USING btree ("project_id" uuid_ops) WHERE "environment"."is_primary";--> statement-breakpoint
COMMENT ON COLUMN "environment"."is_primary" IS 'True for the project''s one primary environment: the landing, the status and the source a new environment copies. Unique per project.';--> statement-breakpoint
COMMENT ON COLUMN "environment"."is_pinned" IS 'True when the owner pinned the environment; pinned environments are listed right after the primary one.';
