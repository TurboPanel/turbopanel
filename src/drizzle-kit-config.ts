import { dirname, fromFileUrl, join } from '@std/path'
import { resolvePostgresConnectionParts } from './db-url.ts'

const INSTANCE_REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), '..')

/** Write a drizzle-kit config that supports Unix-socket postgres URLs. */
export async function writeDrizzleKitConfig(url: string, configPath: string): Promise<void> {
  const parts = resolvePostgresConnectionParts(url)
  if (!parts) {
    throw new Error('invalid TURBOPANEL_DATABASE_URL')
  }

  const dbCredentials = parts.socketDir
    ? `{
    host: ${JSON.stringify(parts.socketDir)},
    user: ${JSON.stringify(parts.user)},
    password: ${JSON.stringify(parts.pass)},
    database: ${JSON.stringify(parts.database)},
  }`
    : `{ url: ${JSON.stringify(parts.tcpUrl ?? url)} }`

  const configContent = `import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  migrations: { table: 'migration', schema: 'public' },
  dialect: 'postgresql',
  dbCredentials: ${dbCredentials},
})
`

  await Deno.mkdir(dirname(configPath), { recursive: true })
  await Deno.writeTextFile(configPath, configContent)
}

export const DRIZZLE_STUDIO_CONFIG = join(INSTANCE_REPO_ROOT, '.local', 'drizzle-studio.config.mjs')
