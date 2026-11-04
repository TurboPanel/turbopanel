-- The control plane's own certificate sources take names that say how they
-- are issued: `lets-encrypt` becomes `acme-http-01` and `dns-01` becomes
-- `acme-dns-01`, in `origin.source` and `certificate.kind`. Each CHECK is
-- dropped, existing rows are renamed, then the CHECK is added with the new
-- names, so this runs on a populated database. The daemon wire keeps its own
-- names; the control plane maps them when it sends a hostname list.
ALTER TABLE "origin" DROP CONSTRAINT "origin_source_check";--> statement-breakpoint
ALTER TABLE "certificate" DROP CONSTRAINT "certificate_kind_check";--> statement-breakpoint
UPDATE "origin" SET "source" = 'acme-http-01' WHERE "source" = 'lets-encrypt';--> statement-breakpoint
UPDATE "origin" SET "source" = 'acme-dns-01' WHERE "source" = 'dns-01';--> statement-breakpoint
UPDATE "certificate" SET "kind" = 'acme-dns-01' WHERE "kind" = 'dns-01';--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_source_check" CHECK (source IN ('platform-ca', 'uploaded', 'acme-http-01', 'acme-dns-01'));--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_kind_check" CHECK (kind IN ('uploaded', 'acme-dns-01'));--> statement-breakpoint
COMMENT ON COLUMN "origin"."source" IS 'Certificate source for this name: `platform-ca`, `uploaded`, `acme-http-01` (Let''s Encrypt over HTTP-01) or `acme-dns-01` (Let''s Encrypt over DNS-01).';--> statement-breakpoint
COMMENT ON COLUMN "origin"."uploaded_cert_id" IS 'Pair (`certificate.id`) this name serves: the upload when `source` is `uploaded` (required), or the issued pair when `source` is `acme-dns-01`; otherwise NULL.';--> statement-breakpoint
COMMENT ON COLUMN "origin"."acme_state" IS 'DNS-01 order and renewal progress for an `acme-dns-01` name (stage, attempts, retry and renewal times, alerts sent); holds no key or token, NULL otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "certificate"."kind" IS '`uploaded` for an operator upload, `acme-dns-01` for a pair the control plane issued itself over DNS-01; issued pairs are never listed as uploads.';
