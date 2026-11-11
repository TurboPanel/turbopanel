ALTER TABLE "binding" ADD COLUMN "preset" varchar(16);--> statement-breakpoint
ALTER TABLE "binding" ADD CONSTRAINT "binding_preset_check" CHECK (preset IS NULL OR preset IN ('postgres', 'mysql', 'laravel', 'wordpress', 'metabase', 'uptime-kuma'));--> statement-breakpoint
COMMENT ON COLUMN "binding"."preset" IS 'App naming preset whose unprefixed names this binding also emits; NULL means the plain engine names when is_emit_engine_defaults is true.';--> statement-breakpoint
COMMENT ON COLUMN "binding"."is_emit_engine_defaults" IS 'True when the binding also emits unprefixed names (its preset, or the plain PG*/MYSQL_* names when preset is NULL); at most one such binding per service.';
