ALTER TABLE "hostname" ADD COLUMN "certificate" text;--> statement-breakpoint
ALTER TABLE "hostname" ADD COLUMN "tls_id" uuid;--> statement-breakpoint
ALTER TABLE "hostname" ADD CONSTRAINT "hostname_tls_id_tls_id_fk" FOREIGN KEY ("tls_id") REFERENCES "public"."tls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hostname_tls_id" ON "hostname" USING btree ("tls_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "hostname" ADD CONSTRAINT "hostname_certificate_check" CHECK (certificate IS NULL OR certificate IN ('cloudflare_origin', 'letsencrypt_http', 'letsencrypt_dns', 'self_signed', 'library'));--> statement-breakpoint
UPDATE "hostname" n SET
  "tls_id" = h.tls_id,
  "certificate" = CASE
    WHEN h.tls_id IS NULL OR t.id IS NULL THEN 'self_signed'
    WHEN t.source = 'provider_origin' THEN 'cloudflare_origin'
    WHEN t.source = 'lets_encrypt' THEN 'letsencrypt_http'
    ELSE 'library' END
FROM "hosting" h LEFT JOIN "tls" t ON t.id = h.tls_id
WHERE h.id = n.hosting_id;--> statement-breakpoint
UPDATE "hostname" n SET "certificate" = 'self_signed', "tls_id" = NULL
FROM "doorway" d
WHERE d.hosting_id = n.hosting_id AND lower(d.hostname) = lower(n.hostname)
  AND d.is_local_only AND d.status <> 'removing'
  AND n.certificate = 'letsencrypt_http';
