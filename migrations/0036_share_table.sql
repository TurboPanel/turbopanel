CREATE TABLE "share" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"environment_id" uuid NOT NULL,
	"service_id" uuid,
	"storage_id" uuid,
	CONSTRAINT "share_asset_check" CHECK ((service_id IS NOT NULL AND storage_id IS NULL) OR (service_id IS NULL AND storage_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share" ADD CONSTRAINT "share_storage_id_storage_id_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."storage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_share_environment_id" ON "share" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_share_service_id" ON "share" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_share_storage_id" ON "share" USING btree ("storage_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_share_environment_service" ON "share" USING btree ("environment_id","service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_share_environment_storage" ON "share" USING btree ("environment_id","storage_id") WHERE storage_id IS NOT NULL;--> statement-breakpoint
COMMENT ON TABLE "share" IS 'An environment using a common asset, a service or volume shared by a site owner; the asset cannot be deleted while a row names it.';--> statement-breakpoint
COMMENT ON COLUMN "share"."environment_id" IS 'The environment that uses the common asset; it may belong to any project of the organization.';--> statement-breakpoint
COMMENT ON COLUMN "share"."service_id" IS 'The common service being used; exactly one of service_id and storage_id is set.';--> statement-breakpoint
COMMENT ON COLUMN "share"."storage_id" IS 'The common volume being used; exactly one of service_id and storage_id is set.';