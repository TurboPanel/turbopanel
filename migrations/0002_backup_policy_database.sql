ALTER TABLE "retention" ADD COLUMN "database" text;--> statement-breakpoint
COMMENT ON COLUMN "retention"."database" IS 'Managed target: the database each run dumps (API field `database`); NULL means the cluster''s initial database.';
