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
 *   that brought a migration shows up before the restart). One SELECT and one
 *   file read, cached 30 s. Null when it cannot be read or the history is not a
 *   prefix of the manifest (the boot gate will say why).
 *
 * `host` is null when no status arrived or the co-located daemon is offline.
 * Development entry only; never reachable from the Workers or production entries.
 */
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import type { DevHostPart, DevHostSetupNeeded, DevHostStatus } from '../contracts/cell-protocol.ts'
import { resolveInstanceRevision } from '../app/build-info.ts'
import { getInstanceCommit } from '../daemon/version.ts'
import type { Db } from '../db/connection.ts'
import {
  compareSchemaState,
  readAppliedMigrationHashes,
  readShippedMigrationHashes,
  type SchemaState,
} from '../db/schema-state.ts'
import { logWarn } from '../lib/logger.ts'
import { type DevHostStatusStore, devHostStatusStore } from './dev-host-status.ts'

const LOG_COMPONENT = 'development-host'

export const MIGRATE_PENDING_CACHE_MS = 30_000

export type DevHostMigrate = { pending: number }

export type DevHostView = DevHostStatus & { migrate: DevHostMigrate | null }

/** Pending count for a schema state; null when migrate would refuse (ahead or diverged). */
export function migratePendingFromState(state: SchemaState): DevHostMigrate | null {
  switch (state.status) {
    case 'current':
      return { pending: 0 }
    case 'unmigrated':
      return { pending: state.shipped }
    case 'behind':
      return { pending: state.pending.length }
    default:
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

async function readMigratePendingUncached(db: Db): Promise<DevHostMigrate | null> {
  const [applied, shipped] = await Promise.all([
    readAppliedMigrationHashes(db),
    readShippedMigrationHashes(),
  ])
  return migratePendingFromState(compareSchemaState(applied, shipped))
}

export const readMigratePending = createMigratePendingReader(readMigratePendingUncached)

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
