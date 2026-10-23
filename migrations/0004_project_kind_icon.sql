-- breaking-ok: nothing is live before the fold; the old type key is moved into the new kind column
ALTER TABLE "project" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "icon" text;--> statement-breakpoint
UPDATE "project" SET "kind" = CASE "metadata"->>'type' WHEN 'docker-compose' THEN 'compose' WHEN 'template' THEN 'compose' WHEN 'managed' THEN 'managed' WHEN 'system' THEN 'system' ELSE NULL END WHERE jsonb_typeof("metadata") = 'object' AND "metadata" ? 'type';--> statement-breakpoint
UPDATE "project" SET "metadata" = NULLIF("metadata" - 'type', '{}'::jsonb) WHERE jsonb_typeof("metadata") = 'object' AND "metadata" ? 'type';--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_kind_check" CHECK (kind IS NULL OR kind IN ('compose', 'managed', 'system'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_icon_check" CHECK (icon IS NULL OR icon IN ('cube', 'globe', 'cart', 'bolt', 'chat', 'chart', 'code', 'book', 'layers', 'mail', 'rocket', 'image'));--> statement-breakpoint
COMMENT ON COLUMN "project"."metadata" IS 'Client jsonb: the catalog `code` of a template or managed engine project, plus free caller keys; the project type lives in `kind`.';--> statement-breakpoint
COMMENT ON COLUMN "project"."kind" IS 'What the project is: `compose` (a template too), `managed` or platform-only `system`; NULL while a draft that has not chosen yet.';--> statement-breakpoint
COMMENT ON COLUMN "project"."icon" IS 'Icon key from the fixed list the project screens offer; NULL means the default, and a managed project ignores it.';
