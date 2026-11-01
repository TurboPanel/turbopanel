CREATE TABLE "ticket" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid NOT NULL,
	"license_id" uuid,
	"server_id" uuid,
	"server_name" text,
	"token" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"used_at" timestamp(3) with time zone,
	"used_by_server_id" uuid,
	"created_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_event_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_event_check";--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "rule_event_check";--> statement-breakpoint
ALTER TABLE "license" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_license_id_license_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."license"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_used_by_server_id_server_id_fk" FOREIGN KEY ("used_by_server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ticket_organization_id" ON "ticket" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_license_id" ON "ticket" USING btree ("license_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_server_id" ON "ticket" USING btree ("server_id");--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced'));--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_event_check" CHECK (event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced'));--> statement-breakpoint
UPDATE "license" SET "token" = NULL WHERE "server_id" IS NOT NULL AND "token" IS NOT NULL;--> statement-breakpoint
COMMENT ON COLUMN "license"."token" IS 'Argon2id PHC hash of the registration key; NULL once the key binds to a server and for a key minted behind a ticket, and a NULL token verifies nothing.';--> statement-breakpoint
COMMENT ON TABLE "ticket" IS 'One-hour, single-use enrolment ticket: a join ticket (license_id set) stands in for a key at install, a re-enroll ticket (server_id set) re-keys one server.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."license_id" IS 'Registration key a join ticket binds when its server enrolls; null for a re-enroll ticket, CASCADE on delete.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."server_id" IS 'The one server a re-enroll ticket is bound to; null for a join ticket. Presented for any other server it is refused.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."server_name" IS 'Display name chosen in Add Server for a join ticket; informational.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."token" IS 'Argon2id PHC hash of the ticket secret; the plaintext is returned once at mint and cannot be recovered from this row.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."expires_at" IS 'Mint time plus one hour; past it the ticket is refused.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."used_at" IS 'Set atomically when the ticket is spent (or when an owner revokes it); a non-null value means it can never be used again.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."used_by_server_id" IS 'Server the spent ticket produced or re-keyed, SET NULL on delete.';--> statement-breakpoint
COMMENT ON COLUMN "ticket"."created_by_user_id" IS 'User who issued the ticket, SET NULL on delete.';
