import { sql } from 'drizzle-orm'
import type { Db } from '../db.ts'

/** Apply 0001/0004 schema elements when drizzle skipped them on existing databases. */
export async function repairSchemaFromMigrations(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "license" (
      "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "organization_id" uuid NOT NULL,
      "display_name" varchar(255),
      "hashed_token" text NOT NULL,
      "revoked_at" timestamp(3) with time zone
    )
  `)

  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "server" ADD COLUMN "license_id" uuid;
    EXCEPTION WHEN duplicate_column THEN null;
    END $$
  `)

  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "invitation" ADD COLUMN "grants" jsonb;
    EXCEPTION WHEN duplicate_column THEN null;
    END $$
  `)

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "access_subject_resource_role_unique"
      ON "access" ("subject_kind","subject_id","resource_id","role_id")
      WHERE role_id IS NOT NULL
  `)

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "access_subject_resource_permission_unique"
      ON "access" ("subject_kind","subject_id","resource_id","permission_id")
      WHERE permission_id IS NOT NULL
  `)
}
