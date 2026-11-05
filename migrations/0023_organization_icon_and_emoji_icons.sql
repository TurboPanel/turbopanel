-- Organizations get an icon like projects have, and an icon may now also be
-- one emoji. `project_icon_check` is dropped and added again with the wider
-- rule (NULL, a key from the fixed list, or 1 to 16 characters with no ASCII);
-- every value the old rule allowed still passes, so existing rows validate.
-- The exact one-emoji rule is checked by the control plane before each write.
-- `is_emoji_icon_allowed` defaults to true, so nothing changes until an
-- organization turns emoji icons off; stored icons are never rewritten.
ALTER TABLE "project" DROP CONSTRAINT "project_icon_check";--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "is_emoji_icon_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_icon_check" CHECK (icon IS NULL OR icon IN ('cube', 'globe', 'cart', 'bolt', 'chat', 'chart', 'code', 'book', 'layers', 'mail', 'rocket', 'image') OR (char_length(icon) BETWEEN 1 AND 16 AND icon !~ '[[:ascii:]]'));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_icon_check" CHECK (icon IS NULL OR icon IN ('cube', 'globe', 'cart', 'bolt', 'chat', 'chart', 'code', 'book', 'layers', 'mail', 'rocket', 'image') OR (char_length(icon) BETWEEN 1 AND 16 AND icon !~ '[[:ascii:]]'));--> statement-breakpoint
COMMENT ON COLUMN "organization"."icon" IS 'Icon key from the same fixed list as `project.icon`, or one emoji; NULL means the default icon.';--> statement-breakpoint
COMMENT ON COLUMN "organization"."is_emoji_icon_allowed" IS 'Emoji icons allowed for the organization and its projects; off refuses new emoji icons and shows the default for stored ones, which are kept.';--> statement-breakpoint
COMMENT ON COLUMN "project"."icon" IS 'Icon key from the fixed list, or one emoji; NULL means the default. A managed project ignores it, the screens an emoji while emoji icons are off.';
