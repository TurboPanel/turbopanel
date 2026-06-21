import { repairResourceRegistry } from '../src/authz/repair.ts'
import { repairSchemaFromMigrations } from '../src/authz/schema-repair.ts'
import { createToolingDb } from '../src/db.ts'

const db = createToolingDb()
await repairSchemaFromMigrations(db)
await repairResourceRegistry(db)
