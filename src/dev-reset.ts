import { sql } from 'drizzle-orm'
import type { Db } from './db.ts'
import { pushSchemaFromCode } from './db/schema-push.ts'
import { stopDrizzleStudio } from './drizzle-studio.ts'

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

/** Wipe dev Postgres, repush schema.ts, and restart the instance for a fresh install wizard. */
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
