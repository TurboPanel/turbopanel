-- breaking-ok: every database is wiped before the baseline release, so no old Worker reads these tables
-- Single-word table names: "grant" becomes "permission" and "2fa" becomes "totp".
-- The renames keep every row; the constraints and indexes follow the new names.
ALTER TABLE "grant" RENAME TO "permission";--> statement-breakpoint
ALTER TABLE "2fa" RENAME TO "totp";--> statement-breakpoint
ALTER TABLE "permission" RENAME CONSTRAINT "grant_unique" TO "permission_unique";--> statement-breakpoint
ALTER TABLE "permission" RENAME CONSTRAINT "grant_actor_type_check" TO "permission_actor_type_check";--> statement-breakpoint
ALTER TABLE "permission" RENAME CONSTRAINT "grant_entity_type_check" TO "permission_entity_type_check";--> statement-breakpoint
ALTER TABLE "totp" RENAME CONSTRAINT "uniq_2fa_user_id" TO "uniq_totp_user_id";--> statement-breakpoint
ALTER TABLE "totp" RENAME CONSTRAINT "2fa_user_id_user_id_fk" TO "totp_user_id_user_id_fk";--> statement-breakpoint
ALTER INDEX "idx_grant_entity" RENAME TO "idx_permission_entity";--> statement-breakpoint
ALTER INDEX "idx_grant_actor" RENAME TO "idx_permission_actor";--> statement-breakpoint
ALTER INDEX "idx_2fa_user_id" RENAME TO "idx_totp_user_id";--> statement-breakpoint
COMMENT ON TABLE "permission" IS 'Allow-only ACL row: one positive grant of `permission` from a subject (`actor_type`, `actor_id`) on an entity; written by access routes, invitations, install.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."actor_type" IS 'Subject kind holding the grant: `user`, `team` or `organization` (`SUBJECT_TYPES` in `src/client/authz/catalog.ts`).';--> statement-breakpoint
COMMENT ON COLUMN "permission"."actor_id" IS 'Id of the subject row named by `actor_type` (a `user`, `team` or `organization` id); no FK because the referenced table varies.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."entity_type" IS 'Kind of the entity granted on: a resource-tree kind or `team` (`GRANT_ENTITY_TYPES`); `principal` and `repository` are deliberately excluded.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."entity_id" IS 'Id of the entity row named by `entity_type`; no FK because the referenced table varies, and ancestry is resolved from the domain tables at evaluation time.';--> statement-breakpoint
COMMENT ON COLUMN "permission"."permission" IS 'Grantable permission key: `organization:own`, `organization:manage`, `team:own`, `team:manage`, `system:read` or `system:operate`; never `system:manage`.';--> statement-breakpoint
COMMENT ON TABLE "totp" IS 'TOTP enrolment for a user, at most one row per user (`uniq_totp_user_id`); inserted or reset on enable, verified once, and deleted when two-factor is disabled.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."user_id" IS 'Enrolled user; unique, so re-enabling resets the existing row instead of adding one, and disable deletes it.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."secret" IS 'TOTP shared secret sealed as a `tpsecret` envelope with the data-encryption key; never plaintext and never returned after enrolment.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."is_verified" IS 'False until the user proves the first six-digit code; only a verified row turns on `user.is_2fa_enabled` and receives backup codes.';--> statement-breakpoint
COMMENT ON COLUMN "totp"."backup_codes" IS 'JSON array of HMAC verifier envelopes (`tpotp.vN.hex`) for the ten one-time backup codes, `[]` until verified; a used code is removed from the array.';--> statement-breakpoint
COMMENT ON COLUMN "user"."is_2fa_enabled" IS 'Derived flag kept in step with the `totp` row: set true when TOTP enrolment is verified and false when two-factor is disabled.';
