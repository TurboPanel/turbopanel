CREATE TABLE "container" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"service_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"metadata" jsonb,
	"options" jsonb
);
--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container" ADD CONSTRAINT "container_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_container_service_id" ON "container" USING btree ("service_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_container_server_id" ON "container" USING btree ("server_id" uuid_ops);