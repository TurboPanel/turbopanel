import { sql } from 'drizzle-orm'
import { dirname, fromFileUrl, join } from '@std/path'
import { ensureRootProvisioned } from './auth/root-provisioning.ts'
import type { Db } from './db.ts'
import { stopDrizzleStudio } from './drizzle-studio.ts'

const INSTANCE_REPO_ROOT = (() => {
  const here = dirname(fromFileUrl(import.meta.url))
  return join(here, '..')
})()

const TURBOPANEL_USER = Deno.env.get('TURBOPANEL_USER')?.trim() || 'turbopanel'
const NODE_BIN = Deno.env.get('TURBOPANEL_NODE')?.trim() ||
  '/opt/turbopanel/runtimes/node/current/bin/node'
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

async function pushSchemaFromCode(): Promise<{ ok: true } | { ok: false; error: string }> {
  const drizzleKit = join(INSTANCE_REPO_ROOT, 'node_modules/drizzle-kit/bin.cjs')
  try {
    const out = await new Deno.Command('sudo', {
      args: ['-u', TURBOPANEL_USER, NODE_BIN, drizzleKit, 'push', '--force'],
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

/** Wipe dev Postgres, repush schema.ts, reprovision root org, restart the instance. */
export async function resetDevInstance(db: Db): Promise<DevResetResult> {
  stopDrizzleStudio()

  const wiped = await wipePublicSchema(db)
  if (!wiped.ok) {
    return { ok: false, error: `database wipe failed: ${wiped.error}` }
  }

  const pushed = await pushSchemaFromCode()
  if (!pushed.ok) {
    return { ok: false, error: `schema push failed: ${pushed.error}` }
  }

  try {
    await ensureRootProvisioned(db)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `root provisioning failed: ${message}` }
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
