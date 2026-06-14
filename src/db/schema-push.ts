import { sql } from 'drizzle-orm'
import { dirname, fromFileUrl, join } from '@std/path'
import type { Db } from '../db.ts'
import { resolveNodePath } from '../node-path.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '../..')
})()

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

export async function pushSchemaFromCode(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const drizzleKit = join(INSTANCE_REPO_ROOT, 'node_modules/drizzle-kit/bin.cjs')
  const nodeBin = await resolveNodePath()
  try {
    const out = await new Deno.Command(nodeBin, {
      args: [drizzleKit, 'push', '--force'],
      cwd: INSTANCE_REPO_ROOT,
      env: Deno.env.toObject(),
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (out.success) return { ok: true }
    const stderr = new TextDecoder().decode(out.stderr).trim()
    const stdout = new TextDecoder().decode(out.stdout).trim()
    return {
      ok: false,
      error: stderr || stdout || 'drizzle-kit push failed',
    }
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
