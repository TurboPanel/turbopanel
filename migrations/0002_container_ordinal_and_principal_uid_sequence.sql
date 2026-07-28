CREATE SEQUENCE "public"."principal_uid_seq" INCREMENT BY 1 MINVALUE 10001 MAXVALUE 9223372036854775807 START WITH 10001 CACHE 1;--> statement-breakpoint
SELECT setval(
  'principal_uid_seq',
  GREATEST(
    10001,
    COALESCE(
      (SELECT MAX((metadata->>'uid')::bigint) FROM principal WHERE metadata->>'uid' ~ '^[0-9]+$'),
      10000
    ) + 1
  ),
  false
);--> statement-breakpoint
DROP INDEX "uniq_container_server_container_id";--> statement-breakpoint
ALTER TABLE "container" ALTER COLUMN "container_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "container" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "container" ADD COLUMN "ordinal" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE container SET ordinal = t.rn FROM (
  SELECT id, row_number() OVER (PARTITION BY service_id ORDER BY created_at, id) AS rn
  FROM container
) t WHERE container.id = t.id;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_service_ordinal" ON "container" USING btree ("service_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_container_server_container_id" ON "container" USING btree ("server_id","container_id") WHERE container_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_ordinal_positive_check" CHECK (ordinal >= 1);
