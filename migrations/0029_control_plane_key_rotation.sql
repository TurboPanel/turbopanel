CREATE TABLE "approver" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"passkey_id" uuid,
	"pkid" text NOT NULL,
	"alg" text NOT NULL,
	"public_key_raw" text NOT NULL,
	"rp_id" text NOT NULL,
	"label" text,
	"marked_keyset" integer NOT NULL,
	"unmarked_keyset" integer,
	"unmarked_at" timestamp(3) with time zone,
	CONSTRAINT "approver_alg_check" CHECK (alg IN ('ES256', 'EdDSA')),
	CONSTRAINT "approver_marked_passkey_check" CHECK ((unmarked_at IS NOT NULL) OR (passkey_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "statement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"keyset" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"prev_kid" text NOT NULL,
	"current_kid" text NOT NULL,
	"body" text NOT NULL,
	"approvals" text NOT NULL,
	"approved_by_user_id" uuid,
	"live_at" timestamp(3) with time zone,
	CONSTRAINT "uniq_statement_keyset" UNIQUE("keyset"),
	CONSTRAINT "statement_kind_check" CHECK (kind IN ('rotate', 'revoke', 'passkeys')),
	CONSTRAINT "statement_state_check" CHECK (state IN ('awaiting_key', 'live')),
	CONSTRAINT "statement_live_at_check" CHECK ((state = 'live') = (live_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_event_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_event_check";--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "rule_event_check";--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "trust_pin_passkeys" text;--> statement-breakpoint
ALTER TABLE "approver" ADD CONSTRAINT "approver_passkey_id_passkey_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."passkey"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement" ADD CONSTRAINT "statement_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_approver_marked_pkid" ON "approver" USING btree ("pkid" text_ops) WHERE (unmarked_at IS NULL);--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced', 'panel.identity_next_changed', 'panel.pin_mismatch', 'certificate.expiring', 'server.pin_silent', 'server.pin_missing', 'backup.target_changed', 'panel.key_changed', 'panel.approvers_changed'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced', 'panel.identity_next_changed', 'panel.pin_mismatch', 'certificate.expiring', 'server.pin_silent', 'server.pin_missing', 'backup.target_changed', 'panel.key_changed', 'panel.approvers_changed'));--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_event_check" CHECK (event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced', 'panel.identity_next_changed', 'panel.pin_mismatch', 'certificate.expiring', 'server.pin_silent', 'server.pin_missing', 'backup.target_changed', 'panel.key_changed', 'panel.approvers_changed'));--> statement-breakpoint
COMMENT ON TABLE "approver" IS 'A sign-in passkey a superadmin marked to approve control plane key changes, with the frozen key servers pin; kept as history once unmarked.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."passkey_id" IS 'The marked sign-in passkey; ON DELETE RESTRICT so it cannot be deleted while marked, and cleared when the passkey is unmarked.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."pkid" IS 'Rotation passkey id servers pin: base64url SHA-256 of the raw credential id; unique among marked rows.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."alg" IS 'Signature algorithm of the pinned key, `ES256` or `EdDSA`.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."public_key_raw" IS 'Base64url raw public key servers verify approvals with: a 65-byte P-256 point or a 32-byte Ed25519 key, copied when marked.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."rp_id" IS 'WebAuthn relying party id the passkey belongs to: the primary hostname when the first passkey was marked.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."label" IS 'Passkey name and owner when marked, for mail and the audit trail.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."marked_keyset" IS 'Key set number of the statement that marked it.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."unmarked_keyset" IS 'Key set number of the statement that unmarked it; NULL while marked.';--> statement-breakpoint
COMMENT ON COLUMN "approver"."unmarked_at" IS 'When it was unmarked; NULL while it still approves key changes.';--> statement-breakpoint
COMMENT ON COLUMN "passkey"."public_key" IS 'Credential public key as a JSON-serialised JWK (ES256, EdDSA or RS256) converted from the attestation''s COSE key; verifies sign-in assertions.';--> statement-breakpoint
COMMENT ON COLUMN "server"."trust_pin_passkeys" IS 'Base64url SHA-256 of the rotation passkeys line in the server pin, from its signed pin report; empty with none pinned, NULL when not reported.';--> statement-breakpoint
COMMENT ON TABLE "statement" IS 'One approved key-set statement of the control plane: the chain every server follows to a new key or passkey set, kept forever in `keyset` order.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."keyset" IS 'Key set number the statement moves servers to; unique and one above the previous statement.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."kind" IS 'What it changes: `rotate` or `revoke` the key, or `passkeys` (mark or unmark rotation passkeys).';--> statement-breakpoint
COMMENT ON COLUMN "statement"."state" IS '`live` when served to servers; `awaiting_key` while a High Availability secret does not hold the new key yet.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."prev_kid" IS 'Fingerprint of the key the statement replaces or keeps; servers apply it only when this is their pinned key.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."current_kid" IS 'Fingerprint of the key servers pin after the statement.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."body" IS 'Exact statement bytes as base64url; the passkey challenge is SHA-256 of these bytes, so they are never rebuilt.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."approvals" IS 'JSON array of the WebAuthn assertions that approved the statement, served to servers as written.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."approved_by_user_id" IS 'Superadmin who approved it; ON DELETE SET NULL so the chain outlives the account.';--> statement-breakpoint
COMMENT ON COLUMN "statement"."live_at" IS 'When the statement started being served; NULL while `awaiting_key`.';
