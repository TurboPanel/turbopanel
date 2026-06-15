import { sql } from 'drizzle-orm'
import { dirname, fromFileUrl, join } from '@std/path'
import type { Db } from '../db.ts'
import { resolveNodePath } from '../node-path.ts'
import { resolvePostgresConnectionParts } from './db-url.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '../..')
})()

const DRIZZLE_PUSH_CONFIG = join(
  INSTANCE_REPO_ROOT,
  '.local',
  'drizzle-push.config.mjs',
)

export async function isDbSchemaReady(db: Db): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'user'
    ) AS "exists"
  `)
  const row = rows[0]
  return row?.exists === true
}

async function writeDrizzlePushConfig(url: string): Promise<void> {
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
  dialect: 'postgresql',
  dbCredentials: ${dbCredentials},
})
`

  await Deno.mkdir(dirname(DRIZZLE_PUSH_CONFIG), { recursive: true })
  await Deno.writeTextFile(DRIZZLE_PUSH_CONFIG, configContent)
}

export async function pushSchemaFromCode(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const url = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()
  if (!url) {
    return { ok: false, error: 'missing TURBOPANEL_DATABASE_URL' }
  }

  const drizzleKit = join(INSTANCE_REPO_ROOT, 'node_modules/drizzle-kit/bin.cjs')
  const nodeBin = await resolveNodePath()
  try {
    await writeDrizzlePushConfig(url)
    const out = await new Deno.Command(nodeBin, {
      args: [
        drizzleKit,
        'push',
        '--force',
        '--config',
        DRIZZLE_PUSH_CONFIG,
      ],
      cwd: INSTANCE_REPO_ROOT,
      env: Deno.env.toObject(),
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const stderr = new TextDecoder().decode(out.stderr).trim()
    const stdout = new TextDecoder().decode(out.stdout).trim()
    const combined = `${stderr}\n${stdout}`.trim()
    if (!out.success) {
      return {
        ok: false,
        error: combined || 'drizzle-kit push failed',
      }
    }
    if (/error|cannot find module/i.test(combined)) {
      return {
        ok: false,
        error: combined,
      }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

/** Push schema.ts when the live database has no auth tables yet. */
export async function ensureDbSchemaReady(db: Db): Promise<void> {
  if (await isDbSchemaReady(db)) return

  console.warn('[db] schema missing — pushing from schema.ts')
  const pushed = await pushSchemaFromCode()
  if (!pushed.ok) {
    throw new Error(`schema push failed: ${pushed.error}`)
  }
  if (!(await isDbSchemaReady(db))) {
    throw new Error('schema push completed but user table still missing')
  }
}
