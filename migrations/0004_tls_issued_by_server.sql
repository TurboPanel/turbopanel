ALTER TABLE "tls" ADD COLUMN "issued_by_server_id" uuid;--> statement-breakpoint
ALTER TABLE "tls" ADD CONSTRAINT "tls_issued_by_server_id_server_id_fk" FOREIGN KEY ("issued_by_server_id") REFERENCES "public"."server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tls_issued_by_server_id" ON "tls" USING btree ("issued_by_server_id" uuid_ops);--> statement-breakpoint
COMMENT ON COLUMN "tls"."certificate_pem" IS 'Leaf plus intermediate chain PEM; on `lets_encrypt` rows it is null until the serving host''s Caddy has issued the certificate and its daemon has sent a copy.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."private_key_pem" IS 'Private key PEM sealed as a `tpsecret` envelope, never returned by the client API; Let''s Encrypt rows get it from the daemon report and lose it on revoke.';--> statement-breakpoint
COMMENT ON COLUMN "tls"."issued_by_server_id" IS 'Server whose Caddy issued the stored Let''s Encrypt pair (the daemon that reported it); null when no pair is stored or that server was deleted.';
