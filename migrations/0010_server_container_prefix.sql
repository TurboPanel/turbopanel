ALTER TABLE "server" ADD COLUMN "container_prefix" "cidr";--> statement-breakpoint
UPDATE "server" s SET "container_prefix" = r."prefix" FROM "relay" r WHERE r."server_id" = s."id" AND s."container_prefix" IS NULL;--> statement-breakpoint
COMMENT ON COLUMN "server"."container_prefix" IS 'Container range of this server (a /16 from the org container pool), set when first needed; cross-server network subnets come from it, NULL until then.';
