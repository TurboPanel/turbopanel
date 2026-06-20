import { repairResourceRegistry } from '../src/authz/repair.ts'
import { repairSchemaFromMigrations } from '../src/authz/schema-repair.ts'
import { createDenoDb } from '../src/db.ts'

// drizzle-kit accepts DATABASE_URL; mirror that fallback for tooling.
if (!Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()) {
  const databaseUrl = Deno.env.get('DATABASE_URL')?.trim()
  if (databaseUrl) {
    Deno.env.set('TURBOPANEL_DATABASE_URL', databaseUrl)
  }
}

const db = createDenoDb()
await repairSchemaFromMigrations(db)
await repairResourceRegistry(db)
