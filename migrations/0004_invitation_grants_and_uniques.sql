DO $$ BEGIN
 ALTER TABLE "invitation" ADD COLUMN "grants" jsonb;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member" ADD CONSTRAINT "member_org_user_unique" UNIQUE("organization_id","user_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "teammate" ADD CONSTRAINT "teammate_team_user_unique" UNIQUE("team_id","user_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "access_subject_resource_role_unique" ON "access" USING btree ("subject_kind","subject_id","resource_id","role_id") WHERE role_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "access_subject_resource_permission_unique" ON "access" USING btree ("subject_kind","subject_id","resource_id","permission_id") WHERE permission_id IS NOT NULL;
