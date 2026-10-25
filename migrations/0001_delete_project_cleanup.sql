-- Deleting a project (or an environment) removes what it owns in one step.
-- Additive: the folder check is widened, never narrowed, so the previous
-- release still writes only rows the new check accepts. A folder of a deleted
-- environment keeps its row as `removing` (environment_id cleared) until the
-- host confirms it gone, and a principal the deleted project owned and
-- nothing else uses is marked for the removal sweep.
ALTER TABLE "folder" DROP CONSTRAINT "folder_common_scope_check";--> statement-breakpoint
ALTER TABLE "principal" ADD COLUMN "removal_requested_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_common_scope_check" CHECK ((scope = 'common' AND environment_id IS NULL) OR (scope <> 'common' AND (environment_id IS NOT NULL OR state IN ('orphan', 'removing'))));--> statement-breakpoint
COMMENT ON COLUMN "principal"."project_id" IS 'Optional project scope for compose-declared hosting principals; set to NULL when the project is deleted.';--> statement-breakpoint
COMMENT ON COLUMN "principal"."removal_requested_at" IS 'When the delete of its project asked for this unused principal to go; the removal sweep deletes it and its host account once no folder names it.';
