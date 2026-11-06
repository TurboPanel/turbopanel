ALTER TABLE "server" ADD COLUMN "trust_pinned_by" text;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_trust_pinned_by_check" CHECK (trust_pinned_by IS NULL OR trust_pinned_by IN ('install', 'upgrade', 'unsafe'));--> statement-breakpoint
COMMENT ON COLUMN "server"."trust_pinned_by" IS 'How the daemon pinned the panel key: `install`, `upgrade` or `unsafe` (installed with the skip flag); NULL until the daemon reports it.';
