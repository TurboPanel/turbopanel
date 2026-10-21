import { sql } from 'drizzle-orm'
import type { Db } from './connection.ts'

/** Message the readiness and status routes answer when the runtime role has no grants. */
export const DATABASE_ROLES_LACK_GRANTS = 'database roles lack grants'

/** A table every request reads; if the runtime role cannot touch it nothing works. */
const PROBE_TABLE = 'setting'

/** The public routes can fail in bursts; ask the catalog at most this often per isolate. */
const PROBE_CACHE_MS = 15_000
/** A hung database must not double the wait of the request that already failed. */
const PROBE_TIMEOUT_MS = 2_000
let cached: { at: number; missing: string[] } | undefined

type GrantProbeRow = {
  role: string
  schema_usage: boolean
  table_exists: boolean
  table_privileges: boolean | null
}

/**
 * Asks Postgres whether the role this connection runs as can use the `public`
 * schema and read and write the `setting` table. Returns one plain sentence per
 * missing grant (role and object names only, never a connection string), or an
 * empty list when the grants are there, the table does not exist yet (fresh
 * install before the migration), or the question itself cannot be asked.
 *
 * Uses the `has_*_privilege` catalog functions, which work for any role and
 * never fail for lack of a grant, so it can run on the very connection whose
 * grants are missing.
 */
export async function findMissingRuntimeGrants(db: Db): Promise<string[]> {
  const now = Date.now()
  if (cached !== undefined && now - cached.at < PROBE_CACHE_MS) return cached.missing
  const missing = await probeRuntimeGrants(db)
  cached = { at: now, missing }
  return missing
}

/** Test hook: forget the cached answer. */
export function resetGrantProbeCache(): void {
  cached = undefined
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('grant probe timed out')), PROBE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

async function probeRuntimeGrants(db: Db): Promise<string[]> {
  let rows: GrantProbeRow[]
  try {
    rows = await withTimeout(
      Promise.resolve(
        db.execute<GrantProbeRow>(sql`
      SELECT
        current_user::text AS role,
        has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
        t.oid IS NOT NULL AS table_exists,
        has_table_privilege(current_user, t.oid, 'SELECT, INSERT, UPDATE, DELETE') AS table_privileges
      FROM (SELECT 1) AS one
      LEFT JOIN (
        SELECT c.oid FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${PROBE_TABLE} AND c.relkind = 'r'
      ) AS t ON true
    `)
      )
    )
  } catch {
    return []
  }
  const row = rows[0]
  if (row === undefined) return []
  const missing: string[] = []
  if (!row.schema_usage) missing.push(`role ${row.role} lacks USAGE on schema public`)
  if (row.table_exists && row.table_privileges === false) {
    missing.push(`role ${row.role} lacks read/write on table public.${PROBE_TABLE}`)
  }
  return missing
}
