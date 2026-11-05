/**
 * Pin silence: tell "a pinned server is alive but not talking to us" apart
 * from "a server is just offline", and only then raise an alarm.
 *
 * A server pinned to the control plane's key that is talking to an impostor
 * (or that no longer trusts this control plane) never completes a signed
 * session here; from this side it simply goes quiet. So does a server that
 * lost power or its network. The control plane never dials servers, so the
 * only independent sign of life it has is another server's: TurboFabric peers
 * report their tunnel handshakes (`relay.metadata.observed`), and those peers
 * are connected to us, so their reading is current.
 *
 * Rule (thresholds below, owner-adjustable):
 * - Only servers pinned at install or on upgrade that have used the signed
 *   channel (`trust_level >= 2`) and are now offline. Silence starts at
 *   `status_changed_at`, which is also the episode key.
 * - Stage A: the ordinary `server.offline` notice (offline sweep, unchanged).
 * - Stage B `server.pin_silent` (warning): silent for {@link PIN_SILENT_MIN_MS}
 *   while a peer reports a healthy tunnel to it.
 * - Stage C `server.pin_missing` (critical): silent for
 *   {@link PIN_MISSING_MIN_MS} while a peer still reports a healthy tunnel.
 * - No healthy peer reading (`down` or `unknown`): never past stage A; without
 *   a sign of life an impostor cannot be told from a power cut.
 * - Many pinned servers going quiet together ({@link isMassDisconnect} over
 *   the last {@link PIN_SILENCE_MASS_WINDOW_MS}) is a control plane or network
 *   outage: the whole tick raises nothing.
 * - Each stage is raised once per episode; a reconnect clears the state, and
 *   so does a verified signed pin report (`features/servers/pin-report.ts`).
 *
 * Postgres only, run from the existing maintenance tick on both runtimes (the
 * Workers offline-sweep cron and the self-hosted cleanup timer): no cell is
 * woken, nothing polls on its own. Never throws.
 */
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/connection.ts'
import { relay, server } from '../db/schema.ts'
import { recordAudit } from '../features/audit/audit-records.ts'
import { type PairTunnelHealth, pairTunnelHealth } from '../features/fabric/peer-health.ts'
import type { RelayMetadata } from '../features/fabric/fabric-records.ts'
import { emitNotification } from '../features/notifications/emit.ts'
import { compatLogWarn } from '../lib/log-compat.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { mapSequential } from '../lib/sequential.ts'
import { isMassDisconnect } from './cell/mass-disconnect.ts'

/** Silent this long with a live peer tunnel: warn (`server.pin_silent`). */
export const PIN_SILENT_MIN_MS = 30 * 60_000
/** Silent this long with a live peer tunnel: alarm (`server.pin_missing`). */
export const PIN_MISSING_MIN_MS = 6 * 60 * 60_000
/** Servers that went quiet within this window count toward an outage. */
export const PIN_SILENCE_MASS_WINDOW_MS = 60 * 60_000

/** 0 nothing raised, 1 `server.pin_silent` raised, 2 `server.pin_missing` raised. */
export type PinSilenceStage = 0 | 1 | 2

export type PinSilenceDecision = {
  stage: PinSilenceStage
  raise: 'server.pin_silent' | 'server.pin_missing' | null
}

/** Pure: where one silent server stands this tick. A stage is never lowered within an episode. */
export function decidePinSilence(input: {
  silentForMs: number
  evidence: PairTunnelHealth
  massOutage: boolean
  raisedStage: PinSilenceStage
}): PinSilenceDecision {
  const held = { stage: input.raisedStage, raise: null }
  if (input.massOutage || input.evidence !== 'healthy') return held
  if (input.silentForMs >= PIN_MISSING_MIN_MS) {
    return input.raisedStage >= 2 ? held : { stage: 2, raise: 'server.pin_missing' }
  }
  if (input.silentForMs >= PIN_SILENT_MIN_MS) {
    return input.raisedStage >= 1 ? held : { stage: 1, raise: 'server.pin_silent' }
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
}

const PINNED = ['install', 'upgrade']

/** One tick. Returns how many alarms were raised; never throws. */
export async function sweepPinSilence(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  deps: PinSilenceDeps = {}
): Promise<number> {
  const nowMs = (deps.now ?? Date.now)()
  try {
    // A reconnect ends the episode.
    await db
      .update(server)
      .set({ trustSilenceStage: null, trustSilenceSince: null })
      .where(and(eq(server.isConnected, true), isNotNull(server.trustSilenceStage)))
    const rows = await db
      .select({
        id: server.id,
        name: server.name,
        organizationId: server.organizationId,
        isConnected: server.isConnected,
        statusChangedAt: server.statusChangedAt,
        stage: server.trustSilenceStage,
        since: server.trustSilenceSince,
      })
      .from(server)
      .where(and(inArray(server.trustPinnedBy, PINNED), gte(server.trustLevel, 2)))
    const silent = rows.filter(
      (row): row is SilentRow & { isConnected: boolean } =>
        !row.isConnected && row.statusChangedAt !== null
    )
    if (silent.length === 0) return 0
    const recent = silent.filter(
      (row) => nowMs - Date.parse(row.statusChangedAt) <= PIN_SILENCE_MASS_WINDOW_MS
    ).length
    if (isMassDisconnect(recent, rows.length)) {
      compatLogWarn(
        'pin-silence',
        `${recent} pinned servers went quiet together; treated as an outage`
      )
      return 0
    }
    const fabricRows = await db
      .select({ fabricId: relay.fabricId })
      .from(relay)
      .where(
        inArray(
          relay.serverId,
          silent.map((row) => row.id)
        )
      )
    if (fabricRows.length === 0) return 0
    const relays: RelayRow[] = await db
      .select({
        serverId: relay.serverId,
        fabricId: relay.fabricId,
        publicKey: relay.publicKey,
        metadata: relay.metadata,
      })
      .from(relay)
      .where(inArray(relay.fabricId, [...new Set(fabricRows.map((row) => row.fabricId))]))
    // One server at a time: each raise writes, audits and notifies on this client.
    const results = await mapSequential(silent, (row) =>
      stepServer(db, secrets, row, relays, nowMs, deps)
    )
    return results.filter(Boolean).length
  } catch (err) {
    compatLogWarn(
      'pin-silence',
      `pin silence sweep failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return 0
  }
}

type SilentRow = {
  id: string
  name: string | null
  organizationId: string | null
  /** When it went offline: the episode. */
  statusChangedAt: string
  stage: number | null
  since: string | null
}

async function stepServer(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  row: SilentRow,
  relays: readonly RelayRow[],
  nowMs: number,
  deps: PinSilenceDeps
): Promise<boolean> {
  const episode = row.statusChangedAt
  const sameEpisode = row.since !== null && Date.parse(row.since) === Date.parse(episode)
  const raisedStage = (sameEpisode ? (row.stage ?? 0) : 0) as PinSilenceStage
  const decision = decidePinSilence({
    silentForMs: nowMs - Date.parse(episode),
    evidence: peerEvidence(row.id, relays, nowMs),
    massOutage: false,
    raisedStage,
  })
  if (!decision.raise) return false
  await db
    .update(server)
    .set({ trustSilenceStage: decision.stage, trustSilenceSince: episode })
    .where(eq(server.id, row.id))
  const silentMinutes = Math.round((nowMs - Date.parse(episode)) / 60_000)
  await (deps.audit ?? recordAudit)(db, {
    organizationId: row.organizationId,
    actorUserId: null,
    action:
      decision.raise === 'server.pin_missing'
        ? 'server.panel_pin.missing'
        : 'server.panel_pin.silent',
    targetType: 'server',
    targetId: row.id,
    context: { silentMinutes, since: episode },
  })
  if (row.organizationId) {
    await (deps.emit ?? emitNotification)(
      db,
      secrets,
      {
        event: decision.raise,
        organizationId: row.organizationId,
        context: { serverName: row.name, silentMinutes: String(silentMinutes) },
        targetType: 'server',
        targetId: row.id,
      },
      { allowPrivateTargets: true }
    )
  }
  return true
}
