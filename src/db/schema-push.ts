import { sql } from 'drizzle-orm'
import { dirname, fromFileUrl, join } from '@std/path'
import type { Db } from '../db.ts'
import { DRIZZLE_PUSH_CONFIG, writeDrizzleKitConfig } from '../drizzle-kit-config.ts'
import { resolveNodePath } from '../node-path.ts'
import { logWarn } from '../logger.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '../..')
})()

async function writeDrizzlePushConfig(url: string): Promise<void> {
  await writeDrizzleKitConfig(url, DRIZZLE_PUSH_CONFIG)
}

const BOOTSTRAP_TABLES = [
  'user',
  'role',
  'permission',
  'permit',
  'resource',
  'access',
] as const

export async function isDbSchemaReady(db: Db): Promise<boolean> {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('user', 'role', 'permission', 'permit', 'resource', 'access')
  `)
  const count = Number(rows[0]?.count ?? 0)
  return count === BOOTSTRAP_TABLES.length
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

/** Push schema.ts when required bootstrap tables (incl. authz) are missing. */
export async function ensureDbSchemaReady(db: Db): Promise<void> {
  if (await isDbSchemaReady(db)) return

  logWarn('db', 'schema missing — pushing from schema.ts')
  const pushed = await pushSchemaFromCode()
  if (!pushed.ok) {
    throw new Error(`schema push failed: ${pushed.error}`)
  }
  if (!(await isDbSchemaReady(db))) {
    throw new Error(
      `schema push completed but required tables still missing (${BOOTSTRAP_TABLES.join(', ')})`,
    )
  }
}
