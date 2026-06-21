#!/usr/bin/env node
/**
 * Write drizzle-kit studio config from a postgres URL.
 * Usage: node scripts/write-drizzle-studio-config.mjs <databaseUrl> [outputPath]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzleDbCredentials } from './resolve-postgres-url.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const databaseUrl = process.argv[2]
const outputPath = process.argv[3] ??
  join(root, '.local', 'drizzle-studio.config.mjs')

if (!databaseUrl) {
  console.error('usage: write-drizzle-studio-config.mjs <databaseUrl> [outputPath]')
  process.exit(1)
}

let parts
try {
  parts = drizzleDbCredentials(databaseUrl)
} catch {
  console.error('invalid postgres URL')
  process.exit(1)
}
const dbCredentials = parts.host
  ? `{
    host: ${JSON.stringify(parts.host)},
    user: ${JSON.stringify(parts.user)},
    password: ${JSON.stringify(parts.password)},
    database: ${JSON.stringify(parts.database)},
  }`
  : `{ url: ${JSON.stringify(parts.url)} }`

const configContent = `import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  migrations: { table: 'migration', schema: 'public' },
  dialect: 'postgresql',
  dbCredentials: ${dbCredentials},
})
`

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, configContent)
