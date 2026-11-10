ALTER TABLE "rotation" ADD COLUMN "prev_key" text;--> statement-breakpoint
ALTER TABLE "rotation" ADD COLUMN "prev_key_signature" text;--> statement-breakpoint
ALTER TABLE "rotation" ADD CONSTRAINT "rotation_prev_key_signature_check" CHECK ((prev_key IS NULL) = (prev_key_signature IS NULL));--> statement-breakpoint
COMMENT ON COLUMN "rotation"."prev_key" IS 'Base64url raw public key of `prev_kid`, served with the signature; NULL for a revoke and for statements stored before key signatures.';--> statement-breakpoint
COMMENT ON COLUMN "rotation"."prev_key_signature" IS 'Base64url Ed25519 signature by the replaced key over `tp-keyset`, a newline and the statement bytes; NULL for a revoke, which two passkeys approve.';
