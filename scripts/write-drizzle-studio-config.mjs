#!/usr/bin/env node
/**
 * Write drizzle-kit studio config from a postgres URL.
 * Usage: node scripts/write-drizzle-studio-config.mjs <databaseUrl> [outputPath]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzleDbCredentials } from './resolve-postgres-url.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localDir = path.join(root, '.local')
const defaultOutputPath = path.join(localDir, 'drizzle-studio.config.mjs')

/** Resolve and confine CLI output paths to the repo `.local/` directory. */
function resolveSafeOutputPath(rawPath) {
  const resolved = path.resolve(rawPath ?? defaultOutputPath)
  const localPrefix = `${localDir}${path.sep}`
  if (resolved !== localDir && !resolved.startsWith(localPrefix)) {
    throw new Error('output path must stay within .local/')
  }
  return resolved
}

const databaseUrl = process.argv[2]
let outputPath
try {
  outputPath = resolveSafeOutputPath(process.argv[3])
} catch {
  console.error('output path must stay within .local/')
  process.exit(1)
}

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
  schema: './src/lib/db/schema.ts',
  out: './migrations',
  migrations: { table: 'migration', schema: 'public' },
  dialect: 'postgresql',
  dbCredentials: ${dbCredentials},
})
`

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, configContent)
