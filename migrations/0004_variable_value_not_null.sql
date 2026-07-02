UPDATE "variable" SET "value" = '' WHERE "value" IS NULL;--> statement-breakpoint
ALTER TABLE "variable" ALTER COLUMN "value" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "variable" ALTER COLUMN "value" SET NOT NULL;
