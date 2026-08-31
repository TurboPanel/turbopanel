ALTER TABLE "principal" ADD COLUMN "applied_username" varchar(255);--> statement-breakpoint
UPDATE "principal" SET "applied_username" = "username" WHERE "applied_username" IS NULL;--> statement-breakpoint
ALTER TABLE "principal" ALTER COLUMN "applied_username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_applied_username_format_check" CHECK ((char_length((applied_username)::text) >= 1) AND (char_length((applied_username)::text) <= 255) AND ((applied_username)::text ~ '^[A-Za-z_][A-Za-z0-9_-]*$'::text));
