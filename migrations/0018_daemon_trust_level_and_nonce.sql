CREATE TABLE "nonce" (
	"value" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "nonce_kind_check" CHECK (kind IN ('challenge', 'request'))
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "trust_level" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_nonce_expires_at" ON "nonce" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_trust_level_check" CHECK (trust_level BETWEEN 0 AND 2);--> statement-breakpoint
COMMENT ON TABLE "nonce" IS 'Daemon challenge ids and request nonces already used, kept until `expires_at` so a replay inside the window is refused; pruned by the sweep.';--> statement-breakpoint
COMMENT ON COLUMN "nonce"."value" IS 'The used value: the nonce of a sign-in challenge or of a signed daemon request.';--> statement-breakpoint
COMMENT ON COLUMN "nonce"."kind" IS 'What the value protected: `challenge` (enroll or session sign-in) or `request` (a signed daemon request).';--> statement-breakpoint
COMMENT ON COLUMN "nonce"."expires_at" IS 'When the challenge or request stops being valid; the row is deleted after this.';--> statement-breakpoint
COMMENT ON COLUMN "server"."trust_level" IS 'Highest daemon session trust this server has used: 0 unsigned, 1 signed frames, 2 signed with a daemon attach proof; raised only, never lowered.';
