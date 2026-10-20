-- The word base joins the reserved environment and scope names. The new checks are
-- added NOT VALID so this migration does not fail on a database that already holds
-- a row called base. Postgres still checks a NOT VALID constraint on every insert
-- and every update of a row (any column), so an old row called base cannot be
-- changed at all until it is renamed. There is no repair step: pre-release data
-- is wiped before the release.
ALTER TABLE "environment" DROP CONSTRAINT "environment_name_check";--> statement-breakpoint
ALTER TABLE "folder" DROP CONSTRAINT "folder_scope_check";--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_name_check" CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND name NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging', 'base')) NOT VALID;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_scope_check" CHECK (scope = 'common' OR (scope ~ '^[a-z0-9][a-z0-9_-]{0,31}$' AND scope NOT IN ('common', 'home', 'tmp', 'services', 'volumes', 'data', 'sites', 'backup', 'backups', 'logs', 'cache', 'run', 'var', 'etc', 'bin', 'root', 'public', 'releases', 'current', 'shared', 'lost-found', 'tmp-staging', 'base'))) NOT VALID;