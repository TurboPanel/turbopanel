#!/usr/bin/env node
/**
 * Write drizzle-kit studio config from a postgres URL.
 * Usage: node scripts/write-drizzle-studio-config.mjs <databaseUrl> [outputPath]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const databaseUrl = process.argv[2]
const outputPath = process.argv[3] ??
  join(root, '.local', 'drizzle-studio.config.mjs')

if (!databaseUrl) {
  console.error('usage: write-drizzle-studio-config.mjs <databaseUrl> [outputPath]')
  process.exit(1)
}

function resolvePostgresParts(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return undefined
    }
    const user = decodeURIComponent(parsed.username)
    const database = parsed.pathname.replace(/^\//, '')
    if (!user || !database) return undefined
    const socketDir = parsed.searchParams.get('host')?.trim() || null
    if (socketDir) {
      return {
        user,
        pass: decodeURIComponent(parsed.password),
        database,
        socketDir,
        tcpUrl: null,
      }
    }
    if (parsed.hostname) {
      return {
        user,
        pass: decodeURIComponent(parsed.password),
        database,
        socketDir: null,
        tcpUrl: url,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

const parts = resolvePostgresParts(databaseUrl)
if (!parts) {
  console.error('invalid postgres URL')
  process.exit(1)
}

const dbCredentials = parts.socketDir
  ? `{
    host: ${JSON.stringify(parts.socketDir)},
    user: ${JSON.stringify(parts.user)},
    password: ${JSON.stringify(parts.pass)},
    database: ${JSON.stringify(parts.database)},
  }`
  : `{ url: ${JSON.stringify(parts.tcpUrl ?? databaseUrl)} }`

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
