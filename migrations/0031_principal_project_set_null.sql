ALTER TABLE "principal" DROP CONSTRAINT "principal_project_id_project_id_fk";
--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
COMMENT ON COLUMN "principal"."project_id" IS 'Optional project scope for compose-declared hosting principals; set to NULL when the project is deleted, the principal stays.';
