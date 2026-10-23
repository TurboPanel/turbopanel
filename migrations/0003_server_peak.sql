CREATE TABLE "peak" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"bucket" timestamp(3) with time zone NOT NULL,
	"memory_bytes" bigint,
	"cores" integer,
	CONSTRAINT "peak_memory_bytes_check" CHECK (memory_bytes >= 0),
	CONSTRAINT "peak_cores_check" CHECK (cores >= 0),
	CONSTRAINT "peak_reading_check" CHECK (memory_bytes IS NOT NULL OR cores IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "peak" ADD CONSTRAINT "peak_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_peak_server_bucket" ON "peak" USING btree ("server_id","bucket");--> statement-breakpoint
CREATE INDEX "idx_peak_bucket" ON "peak" USING btree ("bucket");--> statement-breakpoint
COMMENT ON TABLE "peak" IS 'Highest RAM and physical core readings of one server per UTC hour; the over-tier rules judge a server on the highest reading of the last 7 days.';--> statement-breakpoint
COMMENT ON COLUMN "peak"."server_id" IS 'Owning server; ON DELETE CASCADE so a deleted host leaves no readings, and (server_id, bucket) is UNIQUE so an upsert only raises the hour.';--> statement-breakpoint
COMMENT ON COLUMN "peak"."bucket" IS 'Start of the UTC hour the readings cover, aligned by the writer; rows older than the 7-day grace window are pruned by the 15-minute cron.';--> statement-breakpoint
COMMENT ON COLUMN "peak"."memory_bytes" IS 'Highest total RAM in bytes read in the hour; NULL when none was read, never negative.';--> statement-breakpoint
COMMENT ON COLUMN "peak"."cores" IS 'Highest physical core count read in the hour; NULL when none was read, never negative.';
