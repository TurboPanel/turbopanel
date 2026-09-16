ALTER TABLE "invitation" ADD COLUMN "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "leaf" ADD COLUMN "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery" ADD COLUMN "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL;