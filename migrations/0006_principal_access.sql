-- breaking-ok: nothing is live before the fold; the access level moves out of principal.options.shell into a checked column
ALTER TABLE "principal" ADD COLUMN "access" text DEFAULT 'sftp' NOT NULL;--> statement-breakpoint
UPDATE "principal" SET "access" = CASE "options" ->> 'shell'
  WHEN '/bin/bash' THEN 'shell'
  WHEN '/bin/sh' THEN 'shell'
  WHEN '/bin/false' THEN 'none'
  ELSE 'sftp'
END;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_access_check" CHECK (access IN ('none', 'sftp', 'shell'));--> statement-breakpoint
COMMENT ON COLUMN "principal"."access" IS 'Site owner SSH access: `none` (no login, keys kept), `sftp` (file transfer only) or `shell` (shell plus file transfer).';--> statement-breakpoint
COMMENT ON COLUMN "principal"."options" IS 'Host-account settings: optional operator `uid`/`gid` override and `nameScheme`; parsed by `parsePrincipalOptions`.';
