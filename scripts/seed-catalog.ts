import { repairResourceRegistry } from '../src/authz/repair.ts'
import { repairSchemaFromMigrations } from '../src/authz/schema-repair.ts'
import { getDatabaseUrl } from '../src/db-url.ts'
import { withToolingDb } from '../src/db.ts'

const url = getDatabaseUrl()
if (!url) {
  throw new Error('TURBOPANEL_DATABASE_URL is required')
}

await withToolingDb(async (db) => {
  await repairSchemaFromMigrations(db)
  await repairResourceRegistry(db)
})
