import { repairResourceRegistry } from '../src/authz/repair.ts'
import { repairSchemaFromMigrations } from '../src/authz/schema-repair.ts'
import { getDatabaseUrl } from '../src/db-url.ts'
import { createToolingDb } from '../src/db.ts'

const url = getDatabaseUrl()
if (!url) {
  throw new Error('TURBOPANEL_DATABASE_URL is required')
}

const db = createToolingDb()
await repairSchemaFromMigrations(db)
await repairResourceRegistry(db)
