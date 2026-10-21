ALTER TABLE "login" ADD COLUMN "is_straight_through" boolean;--> statement-breakpoint
COMMENT ON COLUMN "login"."is_straight_through" IS 'PostgreSQL only: true connects the login straight through the front door; NULL means never chosen, so the default applies (API field `straightThrough`).';
