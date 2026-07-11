ALTER TABLE "service" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "hosting" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "hosting" ADD COLUMN "options" jsonb;
