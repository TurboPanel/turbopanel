ALTER TABLE "origin" DROP CONSTRAINT "origin_source_check";--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_event_check";--> statement-breakpoint
ALTER TABLE "attempt" DROP CONSTRAINT "attempt_event_check";--> statement-breakpoint
ALTER TABLE "rule" DROP CONSTRAINT "rule_event_check";--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "acme_state" jsonb;--> statement-breakpoint
ALTER TABLE "certificate" ADD COLUMN "kind" text DEFAULT 'uploaded' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_source_check" CHECK (source IN ('platform-ca', 'uploaded', 'lets-encrypt', 'dns-01'));--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_kind_check" CHECK (kind IN ('uploaded', 'dns-01'));--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced', 'panel.identity_next_changed', 'panel.pin_mismatch', 'certificate.expiring'));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_event_check" CHECK (event IN ('server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced', 'panel.identity_next_changed', 'panel.pin_mismatch', 'certificate.expiring'));--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_event_check" CHECK (event IN ('*', 'server.offline', 'fleet.mass_disconnect', 'server.deleted', 'server.daemon_key_revoked', 'access.grant_created', 'access.grant_revoked', 'certificate.renewal_failed', 'folder.orphans_found', 'server.repo_key_changed', 'server.enrolled', 'server.key_replaced', 'panel.identity_next_changed', 'panel.pin_mismatch', 'certificate.expiring'));--> statement-breakpoint
COMMENT ON COLUMN "origin"."source" IS 'Certificate source for this name: `platform-ca`, `uploaded`, `lets-encrypt`, or `dns-01`.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."uploaded_cert_id" IS 'Pair (`certificate.id`) this name serves: the upload when `source` is `uploaded` (required), or the issued pair when `source` is `dns-01`; otherwise NULL.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."acme_state" IS 'DNS-01 order and renewal progress for a `dns-01` name (stage, attempts, retry and renewal times, alerts sent); holds no key or token, NULL otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."kind" IS '`uploaded` for an operator upload, `dns-01` for a pair the control plane issued itself over DNS-01; issued pairs are never listed as uploads.';
