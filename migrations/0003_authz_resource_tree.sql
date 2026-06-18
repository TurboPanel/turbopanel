CREATE TYPE "public"."effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."subjectkind" AS ENUM('user', 'team', 'organization');--> statement-breakpoint
CREATE TABLE "access" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"subject_kind" "subjectkind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"effect" "effect" DEFAULT 'allow' NOT NULL,
	"role_id" uuid,
	"permission_id" uuid,
	CONSTRAINT "access_one_target_check" CHECK (num_nonnulls("access"."role_id", "access"."permission_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "environment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(255),
	"organization_id" uuid NOT NULL,
	"realm_id" uuid NOT NULL,
	CONSTRAINT "environment_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "environment_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "hosting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(255),
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "hosting_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "hosting_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	CONSTRAINT "permission_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "permit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "permit_role_permission_unique" UNIQUE("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(255),
	"organization_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	CONSTRAINT "project_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "project_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "realm" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(255),
	"organization_id" uuid NOT NULL,
	CONSTRAINT "realm_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "realm_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
CREATE TABLE "resource" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	CONSTRAINT "resource_kind_item_unique" UNIQUE("kind","item_id"),
	CONSTRAINT "resource_id_org_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	CONSTRAINT "role_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "service" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"display_name" varchar(255),
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "service_id_org_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "service_display_name_format_check" CHECK ((display_name IS NULL) OR (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 255)) AND ((display_name)::text ~ '^[A-Za-z0-9 ._-]+$'::text)))
);
--> statement-breakpoint
ALTER TABLE "access" ADD CONSTRAINT "access_resource_id_resource_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resource"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access" ADD CONSTRAINT "access_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access" ADD CONSTRAINT "access_permission_id_permission_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_realm_org_fk" FOREIGN KEY ("realm_id","organization_id") REFERENCES "public"."realm"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting" ADD CONSTRAINT "hosting_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit" ADD CONSTRAINT "permit_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit" ADD CONSTRAINT "permit_permission_id_permission_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_environment_org_fk" FOREIGN KEY ("environment_id","organization_id") REFERENCES "public"."environment"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realm" ADD CONSTRAINT "realm_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_parent_org_fk" FOREIGN KEY ("parent_id","organization_id") REFERENCES "public"."resource"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_project_org_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."project"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_access_subject" ON "access" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "idx_access_resource_id" ON "access" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "idx_access_subject_resource" ON "access" USING btree ("subject_kind","subject_id","resource_id");--> statement-breakpoint
CREATE INDEX "idx_access_role_id" ON "access" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_access_permission_id" ON "access" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "idx_environment_realm_id" ON "environment" USING btree ("realm_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_environment_organization_id" ON "environment" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_project_id" ON "hosting" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_hosting_organization_id" ON "hosting" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_permit_role_id" ON "permit" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "idx_permit_permission_id" ON "permit" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "idx_project_environment_id" ON "project" USING btree ("environment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_project_organization_id" ON "project" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_realm_organization_id" ON "realm" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_resource_parent_id" ON "resource" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_resource_organization_kind" ON "resource" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "idx_service_project_id" ON "service" USING btree ("project_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_service_organization_id" ON "service" USING btree ("organization_id" uuid_ops);--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "member" DROP COLUMN "role";