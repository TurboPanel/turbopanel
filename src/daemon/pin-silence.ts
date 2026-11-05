/**
 * Pin silence: tell "a pinned server is running but not talking to us" apart
 * from "a server is just offline", and only then raise an alarm.
 *
 * A server pinned to the control plane's key that is talking to an impostor
 * (or whose daemon stopped, or can no longer sign in here) never completes a
 * signed session; from this side it simply goes quiet. So does a server that
 * lost power or its network. The control plane never dials servers, so the
 * only independent sign of life it has is another server's: TurboFabric peers
 * report their tunnel handshakes (`relay.metadata.observed`), and those peers
 * are connected to us, so their reading is current. A healthy tunnel says the
 * host is up; it cannot say why its daemon is not here.
 *
 * Rule (thresholds below, owner-adjustable):
 * - Only servers pinned at install or on upgrade that have used the signed
 *   channel (`trust_level >= 2`) and are now offline. The offline episode is
 *   `status_changed_at`.
 * - The clock runs from the first healthy peer reading in the episode
 *   (`trust_silence_alive_at`), not from when the server went offline: a
 *   server booting after a long power cut brings its tunnel up before its
 *   daemon connects, and that gap must not count. A reading that turns `down`
 *   or `unknown` stops the clock; the next healthy one starts it again.
 * - Stage A: the ordinary `server.offline` notice (offline sweep, unchanged).
 * - Stage B `server.pin_silent` (warning): {@link PIN_SILENT_MIN_MS} of
 *   continued healthy peer readings while offline.
 * - Stage C `server.pin_missing` (critical): {@link PIN_MISSING_MIN_MS} of
 *   them, and only after stage B was raised in the same episode.
 * - A server that went offline within {@link PIN_SILENCE_MASS_WINDOW_MS} of
 *   enough others (the mass-disconnect rule, over every server and over its
 *   own organization) is part of an outage, however long ago: nothing raised.
 * - Each stage once per episode; a reconnect clears the state, and so does a
 *   verified signed pin report (`features/servers/pin-report.ts`).
 *
 * Postgres only, run from the existing maintenance tick on both runtimes (the
 * Workers offline-sweep cron and the self-hosted cleanup timer): no cell is
 * woken, nothing polls on its own. Never throws; one server's failure does
 * not stop the others.
 */
import { inArray, eq } from 'drizzle-orm'
import type { Db } from '../db/connection.ts'
import { relay, server } from '../db/schema.ts'
import { recordAudit } from '../features/audit/audit-records.ts'
import { type PairTunnelHealth, pairTunnelHealth } from '../features/fabric/peer-health.ts'
import type { RelayMetadata } from '../features/fabric/fabric-records.ts'
import { type EmitEmail, emitNotification } from '../features/notifications/emit.ts'
import { compatLogWarn } from '../lib/log-compat.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { mapSequential } from '../lib/sequential.ts'
import { isMassDisconnect } from './cell/mass-disconnect.ts'

/** Continued healthy peer readings while offline before a warning (`server.pin_silent`). */
export const PIN_SILENT_MIN_MS = 30 * 60_000
/** Continued healthy peer readings while offline before the alarm (`server.pin_missing`). */
export const PIN_MISSING_MIN_MS = 6 * 60 * 60_000
/** Servers that went offline within this long of each other count as one outage. */
export const PIN_SILENCE_MASS_WINDOW_MS = 60 * 60_000

/** 0 nothing raised, 1 `server.pin_silent` raised, 2 `server.pin_missing` raised. */
export type PinSilenceStage = 0 | 1 | 2

export type PinSilenceDecision = {
  stage: PinSilenceStage
  raise: 'server.pin_silent' | 'server.pin_missing' | null
}

/**
 * Pure: where one silent server stands. `aliveForMs` is how long peers have
 * reported a healthy tunnel to it without a break (null when the latest
 * reading is not healthy). A stage is never skipped and never lowered.
 */
export function decidePinSilence(input: {
  aliveForMs: number | null
  massOutage: boolean
  raisedStage: PinSilenceStage
}): PinSilenceDecision {
  const held = { stage: input.raisedStage, raise: null }
  if (input.massOutage || input.aliveForMs === null) return held
  if (input.raisedStage === 0 && input.aliveForMs >= PIN_SILENT_MIN_MS) {
    return { stage: 1, raise: 'server.pin_silent' }
  }
  if (input.raisedStage === 1 && input.aliveForMs >= PIN_MISSING_MIN_MS) {
    return { stage: 2, raise: 'server.pin_missing' }
  }
  return held
}

type RelayRow = { serverId: string; fabricId: string; publicKey: string | null; metadata: unknown }

/**
 * A peer's view of this server: `healthy` when any other relay in one of its
 * fabrics has a fresh reading with a recent handshake to its key, else `down`
 * when one has a fresh reading without it, else `unknown`.
 */
export function peerEvidence(
  serverId: string,
  relays: readonly RelayRow[],
  nowMs: number
): PairTunnelHealth {
  let result: PairTunnelHealth = 'unknown'
  for (const own of relays) {
    if (own.serverId !== serverId || !own.publicKey) continue
    for (const peer of relays) {
      if (peer.fabricId !== own.fabricId || peer.serverId === serverId) continue
      const observed = (peer.metadata as RelayMetadata | null)?.observed
      const health = pairTunnelHealth(observed, own.publicKey, nowMs)
      if (health === 'healthy') return 'healthy'
      if (health === 'down') result = 'down'
    }
  }
  return result
}

export type PinSilenceDeps = {
  now?: () => number
  emit?: typeof emitNotification
  audit?: typeof recordAudit
  /** The tick's mail transport, so an alarm's email channels go out now. */
  email?: EmitEmail
}

type ServerRow = {
  id: string
  name: string | null
  organizationId: string | null
  isConnected: boolean
  statusChangedAt: string | null
  trustPinnedBy: string | null
  trustLevel: number
  stage: number | null
  since: string | null
  aliveAt: string | null
}

type SilentRow = ServerRow & { statusChangedAt: string }

const PINNED: ReadonlySet<string> = new Set(['install', 'upgrade'])

function isSilentCandidate(row: ServerRow): row is SilentRow {
  return (
    !row.isConnected &&
    row.statusChangedAt !== null &&
    row.trustLevel >= 2 &&
    PINNED.has(row.trustPinnedBy ?? '')
  )
}

/**
 * Whether this server went offline as part of a group: the servers that went
 * offline within {@link PIN_SILENCE_MASS_WINDOW_MS} of it, checked with the
 * mass-disconnect rule against the whole fleet and against its organization.
 */
function outageAround(row: SilentRow, all: readonly ServerRow[]): boolean {
  const at = Date.parse(row.statusChangedAt)
  const nearby = (other: ServerRow) =>
    !other.isConnected &&
    other.statusChangedAt !== null &&
    Math.abs(Date.parse(other.statusChangedAt) - at) <= PIN_SILENCE_MASS_WINDOW_MS
  const sameOrg = all.filter((other) => other.organizationId === row.organizationId)
  return (
    isMassDisconnect(all.filter(nearby).length, all.length) ||
    isMassDisconnect(sameOrg.filter(nearby).length, sameOrg.length)
  )
}

/** One tick. Returns how many alarms were raised; never throws. */
export async function sweepPinSilence(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  deps: PinSilenceDeps = {}
): Promise<number> {
  const nowMs = (deps.now ?? Date.now)()
  try {
    const all: ServerRow[] = await db
      .select({
        id: server.id,
        name: server.name,
        organizationId: server.organizationId,
        isConnected: server.isConnected,
        statusChangedAt: server.statusChangedAt,
        trustPinnedBy: server.trustPinnedBy,
        trustLevel: server.trustLevel,
        stage: server.trustSilenceStage,
        since: server.trustSilenceSince,
        aliveAt: server.trustSilenceAliveAt,
      })
      .from(server)
    // A reconnect ends the episode.
    const reconnected = all.filter(
      (row) => row.isConnected && (row.stage !== null || row.aliveAt !== null)
    )
    if (reconnected.length > 0) {
      await db
        .update(server)
        .set({ trustSilenceStage: null, trustSilenceSince: null, trustSilenceAliveAt: null })
        .where(
          inArray(
            server.id,
            reconnected.map((row) => row.id)
          )
        )
    }
    const silent = all.filter(isSilentCandidate)
    if (silent.length === 0) return 0
    const relays = await relaysAround(
      db,
      silent.map((row) => row.id)
    )
    if (relays.length === 0) return 0
    const results = await mapSequential(silent, (row) =>
      stepServerSafely(db, secrets, row, {
        relays,
        nowMs,
        massOutage: outageAround(row, all),
        deps,
      })
    )
    return results.filter(Boolean).length
  } catch (err) {
    compatLogWarn('pin-silence', `pin silence sweep failed: ${errorText(err)}`)
    return 0
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Every relay in a fabric any of these servers belongs to. */
async function relaysAround(db: Db, serverIds: string[]): Promise<RelayRow[]> {
  const fabrics = await db
    .select({ fabricId: relay.fabricId })
    .from(relay)
    .where(inArray(relay.serverId, serverIds))
  if (fabrics.length === 0) return []
  return await db
    .select({
      serverId: relay.serverId,
      fabricId: relay.fabricId,
      publicKey: relay.publicKey,
      metadata: relay.metadata,
    })
    .from(relay)
    .where(inArray(relay.fabricId, [...new Set(fabrics.map((row) => row.fabricId))]))
}

type StepContext = {
  relays: readonly RelayRow[]
  nowMs: number
  massOutage: boolean
  deps: PinSilenceDeps
}

async function stepServerSafely(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  row: SilentRow,
  ctx: StepContext
): Promise<boolean> {
  try {
    return await stepServer(db, secrets, row, ctx)
  } catch (err) {
    compatLogWarn('pin-silence', `pin silence step for server ${row.id} failed: ${errorText(err)}`)
    return false
  }
}

/** The episode's state as stored, reset when the episode is not the stored one. */
function storedState(row: SilentRow): { stage: PinSilenceStage; aliveAt: string | null } {
  const sameEpisode =
    row.since !== null && Date.parse(row.since) === Date.parse(row.statusChangedAt)
  if (!sameEpisode) return { stage: 0, aliveAt: null }
  return { stage: (row.stage ?? 0) as PinSilenceStage, aliveAt: row.aliveAt }
}

async function stepServer(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  row: SilentRow,
  ctx: StepContext
): Promise<boolean> {
  const stored = storedState(row)
  const healthy = peerEvidence(row.id, ctx.relays, ctx.nowMs) === 'healthy'
  // The clock starts at the first healthy reading and stops when it breaks.
  let aliveAt: string | null = null
  if (healthy) aliveAt = stored.aliveAt ?? new Date(ctx.nowMs).toISOString()
  const decision = decidePinSilence({
    aliveForMs: aliveAt === null ? null : ctx.nowMs - Date.parse(aliveAt),
    massOutage: ctx.massOutage,
    raisedStage: stored.stage,
  })
  const changed =
    decision.stage !== (row.stage ?? 0) ||
    aliveAt !== row.aliveAt ||
    row.since !== row.statusChangedAt
  if (changed) {
    await db
      .update(server)
      .set({
        trustSilenceStage: decision.stage === 0 ? null : decision.stage,
        trustSilenceSince: row.statusChangedAt,
        trustSilenceAliveAt: aliveAt,
      })
      .where(eq(server.id, row.id))
  }
  if (!decision.raise) return false
  await raise(db, secrets, row, decision.raise, ctx)
  return true
}

async function raise(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  row: SilentRow,
  event: 'server.pin_silent' | 'server.pin_missing',
  ctx: StepContext
): Promise<void> {
  const offlineMinutes = Math.round((ctx.nowMs - Date.parse(row.statusChangedAt)) / 60_000)
  await (ctx.deps.audit ?? recordAudit)(db, {
    organizationId: row.organizationId,
    actorUserId: null,
    action: event === 'server.pin_missing' ? 'server.panel_pin.missing' : 'server.panel_pin.silent',
    targetType: 'server',
    targetId: row.id,
    context: { offlineMinutes, since: row.statusChangedAt },
  })
  if (!row.organizationId) return
  await (ctx.deps.emit ?? emitNotification)(
    db,
    secrets,
    {
      event,
      organizationId: row.organizationId,
      context: { serverName: row.name, offlineMinutes: String(offlineMinutes) },
      targetType: 'server',
      targetId: row.id,
    },
    { allowPrivateTargets: true, ...(ctx.deps.email ? { email: ctx.deps.email } : {}) }
  )
}
