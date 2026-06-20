ALTER TABLE "access" ADD COLUMN "access_profile_key" text;--> statement-breakpoint
ALTER TABLE "access" ADD COLUMN "permission_key" text;--> statement-breakpoint
UPDATE "access" SET "access_profile_key" = "role"."key" FROM "role" WHERE "access"."role_id" = "role"."id";--> statement-breakpoint
UPDATE "access" SET "permission_key" = "permission"."key" FROM "permission" WHERE "access"."permission_id" = "permission"."id";--> statement-breakpoint
DROP INDEX IF EXISTS "access_subject_resource_role_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "access_subject_resource_permission_unique";--> statement-breakpoint
ALTER TABLE "access" DROP CONSTRAINT "access_role_id_role_id_fk";--> statement-breakpoint
ALTER TABLE "access" DROP CONSTRAINT "access_permission_id_permission_id_fk";--> statement-breakpoint
ALTER TABLE "access" DROP CONSTRAINT "access_one_target_check";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_access_role_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_access_permission_id";--> statement-breakpoint
ALTER TABLE "access" DROP COLUMN "role_id";--> statement-breakpoint
ALTER TABLE "access" DROP COLUMN "permission_id";--> statement-breakpoint
ALTER TABLE "access" ADD CONSTRAINT "access_one_target_check" CHECK (num_nonnulls("access_profile_key", "permission_key") = 1);--> statement-breakpoint
CREATE INDEX "idx_access_access_profile_key" ON "access" USING btree ("access_profile_key");--> statement-breakpoint
CREATE INDEX "idx_access_permission_key" ON "access" USING btree ("permission_key");--> statement-breakpoint
CREATE UNIQUE INDEX "access_subject_resource_profile_unique" ON "access" USING btree ("subject_kind","subject_id","resource_id","access_profile_key") WHERE access_profile_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "access_subject_resource_permission_unique" ON "access" USING btree ("subject_kind","subject_id","resource_id","permission_key") WHERE permission_key IS NOT NULL;--> statement-breakpoint
DROP TABLE "permit";--> statement-breakpoint
DROP TABLE "role";--> statement-breakpoint
DROP TABLE "permission";
