ALTER TABLE "invitation" ADD COLUMN "token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_invitation_token_hash" ON "invitation" USING btree ("token_hash" text_ops);--> statement-breakpoint
COMMENT ON COLUMN "invitation"."token_hash" IS 'SHA-256 verifier of the secret emailed only in the accept link, used to look the invitation up; rotated on re-send, null on older invitations.';
