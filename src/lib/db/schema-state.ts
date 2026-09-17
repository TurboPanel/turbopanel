/**
 * Schema state: is this database's `public.migration` history what this
 * build's frozen migration manifest says it should be?
 *
 * Three callers, one rule (scripts/schema-state.mjs is the Node twin for
 * `pnpm migrate`; schema-state.test.ts pins the two):
 *
 *   - `turbopanel-instance migrate` and `pnpm migrate` run {@link compareSchemaState}
 *     *before* the drizzle migrator. drizzle applies a journal entry only
 *     when its `when` is newer than the newest `created_at` already
 *     recorded, so on a database migrated by files this build does not ship
 *     (a newer release, or the pre-freeze baseline) it would try to apply
 *     our files on top of a foreign history and fail half-way with a
 *     mid-DDL error. `ahead` and `diverged` refuse up front instead.
 *   - The Deno instance runs it at boot, before `Deno.serve`, and refuses to
 *     start on anything but `current`: the instance never migrates on boot
 *     (the installer and instance-launch do), and serving requests against
 *     a schema that is not the one the code was compiled for is how a
 *     column that "should exist" becomes a 500 on the first request. The
 *     Workers runtime skips this on purpose — `pnpm deploy` migrates before
 *     `wrangler deploy`, and a Worker has no boot to check at.
 *
 * The comparison is against `migrations/meta/manifest.json` — the frozen
 * truth (see scripts/check-migration-freeze.mjs) — and `public.migration`'s
 * `hash` column, which drizzle writes with the same sha256 the manifest
 * records. Applied rows must be exactly a prefix of the manifest, in order.
 */
import { sql } from 'drizzle-orm'
import { dirname, fromFileUrl, join } from '@std/path'
import type { Db } from '../../db.ts'

/**
 * `migrations/` next to `src/` in a checkout, and the copy `deno task compile`
 * embeds (`--include migrations`) in the compiled binary — `import.meta.url`
 * relative either way, never the working directory.
 */
export const MIGRATIONS_FOLDER = join(
  dirname(dirname(dirname(dirname(fromFileUrl(import.meta.url))))),
  'migrations',
)

export type SchemaState =
  | { status: 'current'; applied: number; shipped: number }
  | { status: 'unmigrated'; applied: 0; shipped: number }
  | { status: 'behind'; applied: number; shipped: number; pending: string[] }
  | { status: 'ahead'; applied: number; shipped: number; unknown: string[] }
  | { status: 'diverged'; applied: number; shipped: number; at: number }

/**
 * Pure comparison. `applied` is `public.migration.hash` in `created_at`
 * order (empty when the table does not exist); `shipped` is the manifest's
 * entries in order.
 */
export function compareSchemaState(applied: readonly string[], shipped: readonly string[]): SchemaState {
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

/** One sentence per state, shared verbatim with scripts/schema-state.mjs. */
export function describeSchemaState(state: SchemaState): string {
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
  }
}

export class SchemaStateError extends Error {
  constructor(readonly state: SchemaState) {
    super(describeSchemaState(state))
    this.name = 'SchemaStateError'
  }
}

type ManifestFile = { entries?: Array<{ sha256?: unknown }> }

/** The frozen manifest's hashes, in order. */
export async function readShippedMigrationHashes(
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<string[]> {
  const raw = await Deno.readTextFile(join(migrationsFolder, 'meta', 'manifest.json'))
  const manifest = JSON.parse(raw) as ManifestFile
  const hashes = (manifest.entries ?? []).map((entry) => entry.sha256)
  if (hashes.length === 0 || hashes.some((hash) => typeof hash !== 'string')) {
    throw new Error('migrations/meta/manifest.json has no usable entries')
  }
  return hashes as string[]
}

/** `public.migration.hash` in `created_at` order; `[]` when the table is absent. */
export async function readAppliedMigrationHashes(db: Db): Promise<string[]> {
  const exists = await db.execute<{ present: boolean }>(
    sql`select to_regclass('public.migration') is not null as present`,
  )
  if (!exists[0]?.present) return []
  const rows = await db.execute<{ hash: string }>(
    sql`select hash from public.migration order by created_at, id`,
  )
  return rows.map((row) => row.hash)
}

/**
 * Boot gate for the Deno instance: throws {@link SchemaStateError} on
 * anything but `current`. Connection failures propagate as-is (a database
 * that is not up yet is systemd's restart loop, not a schema problem) — the
 * caller tells the two apart by `instanceof`.
 */
export async function assertSchemaCurrent(
  db: Db,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<SchemaState> {
  const [applied, shipped] = await Promise.all([
    readAppliedMigrationHashes(db),
    readShippedMigrationHashes(migrationsFolder),
  ])
  const state = compareSchemaState(applied, shipped)
  if (state.status !== 'current') throw new SchemaStateError(state)
  return state
}
