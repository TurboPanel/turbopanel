/**
 * Where the job cadence overrides (`src/jobs/registry.ts`) come from.
 *
 * - Workers read the `TURBOPANEL_JOB_CADENCES` var only: `resolveJobCadencesFromEnv`
 *   never touches the database, so a cron tick costs no extra Hyperdrive statement.
 * - Self-hosted reads through `SettingsResolver`: the same env var first, then
 *   the `jobs.cadences` setting row (stored upper-cased as `JOBS__CADENCES`),
 *   then no overrides. The row is cached for a few minutes, so the one-minute
 *   timers do not read it on every pass; an env var skips the database entirely.
 *
 * Neither path throws: an unreadable row keeps the last value read (or the
 * defaults) and says so as a warning.
 */
import type { Db } from '../../db/connection.ts'
import { type ResolvedCadences, resolveJobCadences } from '../../jobs/registry.ts'
import { loadSettingValues, type SettingValue, SettingsResolver } from './resolver.ts'

/** The env var that carries the override map on both runtimes. */
export const JOB_CADENCES_ENV = 'TURBOPANEL_JOB_CADENCES'

/** Setting row `jobs.cadences`: prefix and short key as `SettingsResolver` names them. */
export const JOB_CADENCES_PREFIX = 'jobs'
export const JOB_CADENCES_SHORT_KEY = 'cadences'

/** How long the self-hosted read of the setting row is reused. */
export const JOB_CADENCES_CACHE_MS = 3 * 60_000

type Env = Record<string, string | undefined>

const resolverFor = (env: Env, dbValues: Map<string, SettingValue> = new Map()) =>
  new SettingsResolver({
    prefix: JOB_CADENCES_PREFIX,
    keys: { [JOB_CADENCES_SHORT_KEY]: '' },
    env,
    dbValues,
    envAliases: { [JOB_CADENCES_SHORT_KEY.toUpperCase()]: [JOB_CADENCES_ENV] },
  })

/** Workers: the var only. */
export function resolveJobCadencesFromEnv(env: Env): ResolvedCadences {
  return resolveJobCadences(env[JOB_CADENCES_ENV])
}

let cached: { raw: string; at: number } | null = null

/** Forget the cached setting read; for tests. */
export function resetJobCadencesCacheForTests(): void {
  cached = null
}

/** The JSON text the resolver settles on: env first, then the cached database row. */
async function readRaw(
  db: Db,
  env: Env,
  nowMs: number
): Promise<{ raw: string; warning?: string }> {
  const fromEnv = resolverFor(env)
  if (fromEnv.isEnvOverridden(JOB_CADENCES_SHORT_KEY)) {
    return { raw: fromEnv.resolve(JOB_CADENCES_SHORT_KEY).value }
  }
  if (cached && nowMs - cached.at < JOB_CADENCES_CACHE_MS) return { raw: cached.raw }
  try {
    const fullKey = fromEnv.fullKey(JOB_CADENCES_SHORT_KEY)
    const values = await loadSettingValues(db, [fullKey])
    const raw = resolverFor(env, values).resolve(JOB_CADENCES_SHORT_KEY).value
    cached = { raw, at: nowMs }
    return { raw }
  } catch {
    // Keep the last good read, and retry on the next pass rather than after the cache window.
    return {
      raw: cached?.raw ?? '',
      warning: 'the jobs.cadences setting could not be read; last value kept',
    }
  }
}

/** Self-hosted: env var, then the `jobs.cadences` row (cached), then the defaults. */
export async function loadJobCadences(
  db: Db,
  env: Env,
  nowMs: number = Date.now()
): Promise<ResolvedCadences> {
  const { raw, warning } = await readRaw(db, env, nowMs)
  const resolved = resolveJobCadences(raw)
  return warning ? { ...resolved, warnings: [warning, ...resolved.warnings] } : resolved
}
