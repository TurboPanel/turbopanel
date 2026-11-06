/**
 * The `host` block of `GET /instance/updates/development`: the co-located
 * daemon's last `dev-host-status`, with what only the control plane knows
 * filled in.
 *
 * - The control plane part's `runningCommit` is this process's own commit,
 *   captured once at boot (`captureRunningInstanceCommit`), and its
 *   `restartNeeded` also turns on when that differs from the checkout HEAD.
 * - `migrate.pending` counts shipped migrations the database has not applied
 *   (`compareSchemaState` against `migrations/manifest.json` on disk, so a pull
 *   that brought a migration shows up before the restart); `migrate.applied`
 *   is how many the database has, and `migrate.total` how many trunk ships
 *   (`origin/trunk:migrations/manifest.json`, the checkout's own manifest when
 *   git cannot read that), for the bar's "Database: N of M migrations
 *   applied". One SELECT, one file read and one `git show`, cached 30 s. Null
 *   when it cannot be read or the history is not a prefix of the manifest (the
 *   boot gate will say why).
 *
 * `host` is null when no status arrived or the co-located daemon is offline.
 * Development entry only; never reachable from the Workers or production entries.
 */
import { dirname, fromFileUrl, join } from '@std/path'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import type { DevHostPart, DevHostSetupNeeded, DevHostStatus } from '../contracts/cell-protocol.ts'
import { resolveInstanceRevision } from '../app/build-info.ts'
import { getInstanceCommit } from '../daemon/version.ts'
import type { Db } from '../db/connection.ts'
import {
  compareSchemaState,
  parseMigrationManifest,
  readAppliedMigrationHashes,
  readShippedMigrationHashes,
  type SchemaState,
} from '../db/schema-state.ts'
import { logWarn } from '../lib/logger.ts'
import { type DevHostStatusStore, devHostStatusStore } from './dev-host-status.ts'

const LOG_COMPONENT = 'development-host'

export const MIGRATE_PENDING_CACHE_MS = 30_000

export type DevHostMigrate = {
  /** Migrations in the checkout's manifest the database has not applied. */
  pending: number
  /** Migrations the database has applied. */
  applied: number
  /** Migrations trunk ships (the checkout's count when trunk cannot be read). */
  total: number
}

export type DevHostView = DevHostStatus & { migrate: DevHostMigrate | null }

/**
 * Counts for a schema state; null when migrate would refuse (ahead or
 * diverged). `trunkTotal` is the length of trunk's manifest, or null when it
 * could not be read (then the checkout's count stands in). A trunk that ships
 * fewer than the checkout (a branch with a new migration) never lowers it.
 */
export function migratePendingFromState(
  state: SchemaState,
  trunkTotal: number | null = null
): DevHostMigrate | null {
  const total = Math.max(trunkTotal ?? 0, state.shipped)
  switch (state.status) {
    case 'current':
      return { pending: 0, applied: state.applied, total }
    case 'unmigrated':
      return { pending: state.shipped, applied: 0, total }
    case 'behind':
      return { pending: state.pending.length, applied: state.applied, total }
    default:
      return null
  }
}

/** The instance checkout: this module lives at `<root>/src/developer/`. */
const INSTANCE_ROOT = join(dirname(fromFileUrl(import.meta.url)), '..', '..')

/** A file as `origin/trunk` has it in the instance checkout, or null when git cannot read it. */
export async function showInstanceTrunkFile(path: string): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command('git', {
      args: ['-C', INSTANCE_ROOT, 'show', `origin/trunk:${path}`],
      stdout: 'piped',
      stderr: 'null',
    }).output()
    return success ? new TextDecoder().decode(stdout) : null
  } catch {
    return null
  }
}

/** How many migrations `origin/trunk` ships, or null when git or the manifest cannot be read. */
export async function readTrunkMigrationCount(
  show: (path: string) => Promise<string | null> = showInstanceTrunkFile
): Promise<number | null> {
  const raw = await show('migrations/manifest.json')
  if (raw === null) return null
  try {
    return parseMigrationManifest(raw).length
  } catch {
    return null
  }
}

/** Memoize one async read for `ttlMs`; a failed read is cached as null too. */
export function createMigratePendingReader(
  read: (db: Db) => Promise<DevHostMigrate | null>,
  opts: { ttlMs?: number; now?: () => number } = {}
): (db: Db) => Promise<DevHostMigrate | null> {
  const ttlMs = opts.ttlMs ?? MIGRATE_PENDING_CACHE_MS
  const now = opts.now ?? (() => Date.now())
  let cached: { value: DevHostMigrate | null; atMs: number } | null = null
  return async (db) => {
    const t = now()
    if (cached && t - cached.atMs < ttlMs) return cached.value
    let value: DevHostMigrate | null
    try {
      value = await read(db)
    } catch (err) {
      logWarn(LOG_COMPONENT, `cannot read the migration state: ${String(err)}`)
      value = null
    }
    cached = { value, atMs: t }
    return value
  }
}

/** The three reads behind {@link readMigrateCounts}; tests swap them. */
export type MigrateCountReads = {
  applied: (db: Db) => Promise<string[]>
  shipped: () => Promise<string[]>
  trunkTotal: () => Promise<number | null>
}

const MIGRATE_COUNT_READS: MigrateCountReads = {
  applied: readAppliedMigrationHashes,
  shipped: () => readShippedMigrationHashes(),
  trunkTotal: () => readTrunkMigrationCount(),
}

/** The database's migration counts against the checkout's and trunk's manifests, uncached. */
export async function readMigrateCounts(
  db: Db,
  reads: MigrateCountReads = MIGRATE_COUNT_READS
): Promise<DevHostMigrate | null> {
  const [applied, shipped, trunkTotal] = await Promise.all([
    reads.applied(db),
    reads.shipped(),
    reads.trunkTotal(),
  ])
  return migratePendingFromState(compareSchemaState(applied, shipped), trunkTotal)
}

export const readMigratePending = createMigratePendingReader((db) => readMigrateCounts(db))

let runningCommit: Promise<string | null> | null = null

/**
 * The commit this process started from: `TURBOPANEL_REVISION` or the stamped
 * build when set, else the checkout HEAD read once now. Call at boot, before
 * any pull can move HEAD; later calls return the first answer.
 */
export function captureRunningInstanceCommit(): Promise<string | null> {
  runningCommit ??= (async () => {
    const stamped = resolveInstanceRevision(Deno.env.toObject()).commit
    if (stamped !== 'unknown') return stamped
    const head = (await getInstanceCommit()).commit
    return head === 'unknown' ? null : head
  })()
  return runningCommit
}

/**
 * Pin `TURBOPANEL_REVISION` to the checkout HEAD before the development
 * server starts. The value in `runtime.env` is written only by a converge, so
 * after a pull and restart it names an older commit; the restarted process
 * would then report that commit on `/api/health` and in its attach frame, and
 * the daemon's Update and Restart would fail waiting for the new one. When git
 * cannot name HEAD the stale value is removed, so the process reports
 * `unknown` rather than a wrong commit. Development entry only: production
 * reports the commit stamped into its build or written by the installer.
 */
export async function pinDevelopmentRevision(
  readHead: () => Promise<{ commit: string }> = getInstanceCommit,
  env: Pick<typeof Deno.env, 'set' | 'delete'> = Deno.env
): Promise<string | null> {
  const head = (await readHead()).commit.trim()
  if (/^[0-9a-f]{40}$/.test(head)) {
    env.set('TURBOPANEL_REVISION', head)
    return head
  }
  env.delete('TURBOPANEL_REVISION')
  return null
}

/** Fill the control plane part from this process's own knowledge. */
export function buildDevHostView(
  status: DevHostStatus,
  input: { runningCommit: string | null; migrate: DevHostMigrate | null }
): DevHostView {
  const parts = status.parts.map((part): DevHostPart => {
    if (part.name !== 'control-plane') return part
    const running = input.runningCommit ?? part.runningCommit
    const commitMoved = running !== null && part.headCommit !== '' && running !== part.headCommit
    // The daemon cannot read the database; the control plane's count replaces its value.
    const setupNeeded: DevHostSetupNeeded =
      part.setupNeeded.install === undefined ? {} : { install: part.setupNeeded.install }
    if (input.migrate && input.migrate.pending > 0) {
      setupNeeded.migrate = { pending: input.migrate.pending }
    }
    return {
      ...part,
      runningCommit: running,
      restartNeeded: part.restartNeeded || commitMoved,
      setupNeeded,
    }
  })
  return { ...status, parts, migrate: input.migrate }
}

export type DevHostViewDeps = {
  store?: DevHostStatusStore
  isConnected?: (registry: DaemonCellRegistry, serverId: string) => Promise<boolean>
  readMigratePending?: (db: Db) => Promise<DevHostMigrate | null>
  runningCommit?: () => Promise<string | null>
}

export async function isCellConnected(
  registry: DaemonCellRegistry,
  serverId: string
): Promise<boolean> {
  const snapshot = await registry.getCell(serverId).getSnapshot()
  return snapshot.connected === true
}

/** The `host` block, or null when the co-located daemon sent nothing or is offline. */
export async function readDevHostView(
  db: Db,
  registry: DaemonCellRegistry,
  deps: DevHostViewDeps = {}
): Promise<DevHostView | null> {
  const store = deps.store ?? devHostStatusStore
  const stored = store.get()
  if (!stored) return null
  const connected = await (deps.isConnected ?? isCellConnected)(registry, stored.serverId).catch(
    () => false
  )
  if (!connected) return null
  const [migrate, running] = await Promise.all([
    (deps.readMigratePending ?? readMigratePending)(db),
    (deps.runningCommit ?? captureRunningInstanceCommit)(),
  ])
  return buildDevHostView(stored.status, { runningCommit: running, migrate })
}
