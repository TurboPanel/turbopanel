ALTER TABLE "attempt" DROP CONSTRAINT "attempt_status_check";--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "digest_cadence" text;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "quiet_start_minute" smallint;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "quiet_end_minute" smallint;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "time_zone" varchar(64);--> statement-breakpoint
CREATE INDEX "idx_attempt_held" ON "attempt" USING btree ("channel_id","created_at") WHERE status = 'held';--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_digest_cadence_check" CHECK (digest_cadence IS NULL OR digest_cadence IN ('hourly', 'daily'));--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_quiet_hours_check" CHECK ((quiet_start_minute IS NULL AND quiet_end_minute IS NULL) OR (quiet_start_minute BETWEEN 0 AND 1439 AND quiet_end_minute BETWEEN 0 AND 1439 AND quiet_start_minute <> quiet_end_minute));--> statement-breakpoint
ALTER TABLE "attempt" ADD CONSTRAINT "attempt_status_check" CHECK (status IN ('pending', 'sent', 'failed', 'abandoned', 'held'));--> statement-breakpoint
COMMENT ON COLUMN "channel"."digest_cadence" IS 'Email only: `hourly` or `daily` batches non-urgent events into one summary per window; NULL sends each event as it happens.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."quiet_start_minute" IS 'Quiet hours start as minutes after local midnight (0-1439), set together with `quiet_end_minute`; NULL means no quiet hours.';--> statement-breakpoint
COMMENT ON COLUMN "channel"."quiet_end_minute" IS 'Quiet hours end as minutes after local midnight (0-1439); the window may wrap midnight, and held events go out as one summary when it ends.';--> statement-breakpoint
COMMENT ON COLUMN "attempt"."status" IS '`pending` (default), `sent`, `failed` (retry due), `abandoned` (after 5 attempts) or `held` (waits for quiet hours or a digest); retries skip `held`.';--> statement-breakpoint
COMMENT ON COLUMN "user"."time_zone" IS 'IANA zone (from the supported list) in which quiet hours on the personal channels of this user are read; NULL means UTC.';
