ALTER TABLE "leaf" DROP CONSTRAINT "leaf_kind_check";--> statement-breakpoint
ALTER TABLE "leaf" DROP CONSTRAINT "leaf_kind_keys_check";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leaf_peer_server" ON "leaf" USING btree ("server_id") WHERE "leaf"."kind" = 'peer';--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_kind_check" CHECK (kind IN ('ingress','engine','peer'));--> statement-breakpoint
ALTER TABLE "leaf" ADD CONSTRAINT "leaf_kind_keys_check" CHECK ((
        ("leaf"."kind" IN ('ingress','peer') AND "leaf"."replica_id" IS NULL AND "leaf"."managed_id" IS NULL)
        OR
        ("leaf"."kind" = 'engine' AND "leaf"."replica_id" IS NOT NULL AND "leaf"."managed_id" IS NOT NULL)
      ));