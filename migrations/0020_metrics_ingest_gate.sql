CREATE TABLE "gate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"server_id" uuid NOT NULL,
	"last_sampled_at" timestamp(3) with time zone NOT NULL,
	"sample_tokens" double precision NOT NULL,
	"event_tokens" double precision NOT NULL,
	"events_allowed" integer DEFAULT 0 NOT NULL,
	"refreshed_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_tokens_check" CHECK (sample_tokens >= 0 AND event_tokens >= 0 AND events_allowed >= 0)
);
--> statement-breakpoint
ALTER TABLE "gate" ADD CONSTRAINT "gate_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gate_server_id" ON "gate" USING btree ("server_id");--> statement-breakpoint
COMMENT ON TABLE "gate" IS 'Per-server metrics ingest gate: one stored sample a minute plus a small catch-up burst, and an hourly event budget; one row per server, overwritten in place.';--> statement-breakpoint
COMMENT ON COLUMN "gate"."last_sampled_at" IS 'Sample time of the last stored sample; a sample at or before it is a duplicate or replay and is refused.';--> statement-breakpoint
COMMENT ON COLUMN "gate"."sample_tokens" IS 'Catch-up allowance for samples less than 50 s apart: refills 1 a minute up to 5, one spent per early sample.';--> statement-breakpoint
COMMENT ON COLUMN "gate"."event_tokens" IS 'Hourly event budget: refills 120 an hour up to 120; each stored event spends one, events beyond it are dropped.';--> statement-breakpoint
COMMENT ON COLUMN "gate"."events_allowed" IS 'How many events the last accepted sample was allowed to store.';--> statement-breakpoint
COMMENT ON COLUMN "gate"."refreshed_at" IS 'When the token counts were last brought up to date.';