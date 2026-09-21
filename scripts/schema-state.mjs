/**
 * Node twin of src/db/schema-state.ts for `pnpm migrate`
 * (scripts/migrate-locked.mjs). Same states, same sentences — verbatim, and
 * src/db/schema-state.test.ts pins the two.
 *
 * Why it exists: drizzle applies a journal entry only when its `when` is
 * newer than the newest `created_at` already recorded, so on a database
 * migrated by files this checkout does not ship (a newer release, or the
 * pre-freeze baseline) it would apply our files on top of a foreign history
 * and fail half-way with a mid-DDL error. `ahead` / `diverged` refuse up
 * front. The comparison is against migrations/manifest.json (the frozen
 * truth) and public.migration.hash (drizzle writes the same sha256).
 */
import fs from 'node:fs'
import path from 'node:path'

export function compareSchemaState(applied, shipped) {
  if (applied.length === 0) return { status: 'unmigrated', applied: 0, shipped: shipped.length }
  const shippedSet = new Set(shipped)
  const unknown = applied.filter((hash) => !shippedSet.has(hash))
  if (unknown.length > 0) {
    return { status: 'ahead', applied: applied.length, shipped: shipped.length, unknown }
  }
  for (let i = 0; i < applied.length; i++) {
    if (applied[i] !== shipped[i]) {
      return { status: 'diverged', applied: applied.length, shipped: shipped.length, at: i }
    }
  }
  if (applied.length < shipped.length) {
    return {
      status: 'behind',
      applied: applied.length,
      shipped: shipped.length,
      pending: shipped.slice(applied.length),
    }
  }
  return { status: 'current', applied: applied.length, shipped: shipped.length }
}

export function describeSchemaState(state) {
  switch (state.status) {
    case 'current':
      return `schema current (${state.applied} migration${state.applied === 1 ? '' : 's'} applied)`
    case 'unmigrated':
      return `database has no migration history — run migrate (${state.shipped} shipped)`
    case 'behind':
      return `database is behind this build: ${state.pending.length} shipped migration${
        state.pending.length === 1 ? '' : 's'
      } not applied — run migrate`
    case 'ahead':
      return `database was migrated by files this build does not ship (${state.unknown.length} unknown of ${state.applied} applied) — either a newer release migrated it (upgrade this instance) or it predates the frozen baseline (drop and re-migrate); refusing`
    case 'diverged':
      return `database migration history diverges from this build at position ${state.at} — refusing`
    default:
      throw new Error(`unknown schema state ${String(state.status)}`)
  }
}

export function readShippedMigrationHashes(migrationsFolder) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, 'manifest.json'), 'utf8'),
  )
  const hashes = (manifest.entries ?? []).map((entry) => entry.sha256)
  if (hashes.length === 0 || hashes.some((hash) => typeof hash !== 'string')) {
    throw new Error('migrations/manifest.json has no usable entries')
  }
  return hashes
}

/** `client` is a postgres.js client; returns [] when the table is absent. */
export async function readAppliedMigrationHashes(client) {
  const [present] = await client`select to_regclass('public.migration') is not null as present`
  if (!present?.present) return []
  const rows = await client`select hash from public.migration order by created_at, id`
  return rows.map((row) => row.hash)
}
