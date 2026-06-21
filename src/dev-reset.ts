import { sql } from 'drizzle-orm'
import { dirname, fromFileUrl, join } from '@std/path'
import type { Db } from './db.ts'
import { stopDrizzleStudio } from './developer/drizzle-studio.ts'
import { resolveNodePath } from './node-path.ts'

const INSTANCE_REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), '..')
const INSTANCE_SERVICE = Deno.env.get('TURBOPANEL_INSTANCE_SERVICE')?.trim()

export type DevResetResult =
  | { ok: true; restarted: boolean }
  | { ok: false; error: string }

async function wipePublicSchema(db: Db): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`)
    await db.execute(sql`CREATE SCHEMA public`)
    await db.execute(sql`GRANT ALL ON SCHEMA public TO PUBLIC`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

function commandOutputError(
  label: string,
  out: Deno.CommandOutput,
): { ok: false; error: string } {
  const stderr = new TextDecoder().decode(out.stderr).trim()
  const stdout = new TextDecoder().decode(out.stdout).trim()
  const combined = `${stderr}\n${stdout}`.trim()
  return {
    ok: false,
    error: combined || label,
  }
}

async function runDrizzleMigrate(): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = Deno.env.get('TURBOPANEL_DATABASE_URL')?.trim()
  if (!url) {
    return { ok: false, error: 'missing TURBOPANEL_DATABASE_URL' }
  }

  const drizzleKit = join(INSTANCE_REPO_ROOT, 'node_modules/drizzle-kit/bin.cjs')
  const nodeBin = await resolveNodePath()
  try {
    const out = await new Deno.Command(nodeBin, {
      args: [drizzleKit, 'migrate'],
      cwd: INSTANCE_REPO_ROOT,
      env: Deno.env.toObject(),
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!out.success) {
      return commandOutputError('drizzle-kit migrate failed', out)
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

async function runSeedCatalog(): Promise<{ ok: true } | { ok: false; error: string }> {
  const seedScript = join(INSTANCE_REPO_ROOT, 'scripts/seed-catalog.ts')
  const nodeBin = await resolveNodePath()
  try {
    const out = await new Deno.Command(nodeBin, {
      args: ['--experimental-strip-types', seedScript],
      cwd: INSTANCE_REPO_ROOT,
      env: Deno.env.toObject(),
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    if (!out.success) {
      return commandOutputError('seed-catalog failed', out)
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

function queueInstanceRestart(): boolean {
  if (!INSTANCE_SERVICE) return false
  new Deno.Command('sudo', {
    args: ['systemctl', 'restart', INSTANCE_SERVICE],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  }).spawn()
  return true
}

/** Wipe dev Postgres, apply migrations, repair resource registry, and restart for a fresh install wizard. */
export async function resetDevInstance(db: Db): Promise<DevResetResult> {
  stopDrizzleStudio()

  const wiped = await wipePublicSchema(db)
  if (!wiped.ok) {
    return { ok: false, error: `database wipe failed: ${wiped.error}` }
  }

  const migrated = await runDrizzleMigrate()
  if (!migrated.ok) {
    return { ok: false, error: `schema migrate failed: ${migrated.error}` }
  }

  const seeded = await runSeedCatalog()
  if (!seeded.ok) {
    return { ok: false, error: `resource registry repair failed: ${seeded.error}` }
  }

  const restarted = queueInstanceRestart()
  if (!restarted) {
    return {
      ok: false,
      error:
        'reset completed but instance restart unavailable: TURBOPANEL_INSTANCE_SERVICE is not set',
    }
  }

  return { ok: true, restarted: true }
}
