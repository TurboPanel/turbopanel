/**
 * The pure half of run-token rotation (`run-token-rotation.ts`): the progress
 * kept in `tunnel.metadata.runTokenRotation`, which sealed token each server is
 * given while a rotation is under way, and what the person is told. No
 * database, no clock: connector sync reads it too, without importing the
 * rotation driver.
 */
import type { TunnelRow } from './lifecycle.ts'

/** How long one server may take to report its connector connected on the new token. */
export const ROTATION_SERVER_LIMIT_MS = 10 * 60 * 1000
/** How long an unanswered status question is waited for before it is asked again. */
export const STATUS_ASK_AGAIN_MS = 30 * 1000
/**
 * How long traffic is given to move onto a server's new connector before the
 * next server is restarted (and before old connections are dropped). The
 * provider's rotation steps say: "Wait 10 minutes for traffic to route through
 * the new connectors."
 */
export const ROTATION_SETTLE_MS = 10 * 60 * 1000

export type RotationPhase = 'starting' | 'rolling' | 'finishing' | 'done' | 'stopped'

/** The server being moved now, and the commands that move and check it. */
export type RotationCurrent = {
  serverId: string
  since: string
  connectorsCommandId?: string
  statusCommandId?: string
  statusAskedAt?: string
}

export type RotationState = {
  phase: RotationPhase
  /** Counts every saved step; a save only lands on the step it read (no two writers). */
  step: number
  startedAt: string
  /** Set just before the provider is asked for a new token; a resume then only reads it. */
  providerCalledAt?: string
  /** The sealed new token, kept beside the old one until every server has it. */
  newSecretId?: string
  /** Servers that still run on the old token, in the order they will be moved. */
  pending: string[]
  /** Servers already given the new token. */
  moved: string[]
  current?: RotationCurrent
  /** When the last moved server reported its connector connected on the new token. */
  lastConnectedAt?: string
  finishedAt?: string
  /** Why the rotation stopped, in plain words. */
  stoppedReason?: string
}

const PHASES: readonly RotationPhase[] = ['starting', 'rolling', 'finishing', 'done', 'stopped']

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readCurrent(value: unknown): RotationCurrent | undefined {
  const raw = value as Partial<RotationCurrent> | null | undefined
  const serverId = optionalString(raw?.serverId)
  const since = optionalString(raw?.since)
  if (!serverId || !since) return undefined
  const current: RotationCurrent = { serverId, since }
  const connectors = optionalString(raw?.connectorsCommandId)
  const status = optionalString(raw?.statusCommandId)
  const asked = optionalString(raw?.statusAskedAt)
  if (connectors) current.connectorsCommandId = connectors
  if (status) current.statusCommandId = status
  if (asked) current.statusAskedAt = asked
  return current
}

/** The rotation recorded on a tunnel row's metadata, or null when there is none. Pure. */
export function readRotation(metadata: unknown): RotationState | null {
  const raw = (metadata as { runTokenRotation?: Record<string, unknown> } | null)?.runTokenRotation
  if (!raw || typeof raw !== 'object') return null
  const phase = PHASES.find((p) => p === raw.phase)
  const startedAt = optionalString(raw.startedAt)
  if (!phase || !startedAt) return null
  const state: RotationState = {
    phase,
    step: typeof raw.step === 'number' && Number.isInteger(raw.step) ? raw.step : 0,
    startedAt,
    pending: stringList(raw.pending),
    moved: stringList(raw.moved),
  }
  const optional = {
    providerCalledAt: optionalString(raw.providerCalledAt),
    newSecretId: optionalString(raw.newSecretId),
    finishedAt: optionalString(raw.finishedAt),
    lastConnectedAt: optionalString(raw.lastConnectedAt),
    stoppedReason: optionalString(raw.stoppedReason),
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (state as Record<string, unknown>)[key] = value
  }
  const current = readCurrent(raw.current)
  if (current) state.current = current
  return state
}

/** A rotation that still has work to do on its own (not done, not stopped). */
export function rotationActive(state: RotationState | null): boolean {
  return state !== null && ['starting', 'rolling', 'finishing'].includes(state.phase)
}

/**
 * Which sealed run token a server is given while a rotation is under way: the
 * old one while the server is still waiting its turn, the new one once it has
 * been moved, and the new one for a server that joined after the rotation
 * started (the old token can no longer open a connection). Pure.
 */
export function runSecretFor(
  row: Pick<TunnelRow, 'secretId' | 'metadata'>,
  serverId: string
): string | null {
  const state = readRotation(row.metadata)
  if (!state?.newSecretId || state.phase === 'done') return row.secretId
  return state.pending.includes(serverId) ? row.secretId : state.newSecretId
}

/** What the person is told before a rotation starts. Pure. */
export function rotationWarnings(carrying: readonly string[]): string[] {
  const reconnect =
    "Each server's connector restarts on the new token one server at a time, about ten minutes apart so traffic can move onto each new connector, and at the end every connection is dropped once, so connectors briefly reconnect."
  if (carrying.length === 1) {
    return [
      `Only one server runs this Tunnel, so visitors lose it for a few seconds while its connector restarts. Add a second server first to avoid that. ${reconnect}`,
    ]
  }
  return [reconnect]
}

/** The rotation as the API shows it; never the token or its secret row. */
export type ApiRotation = {
  phase: RotationPhase
  startedAt: string
  finishedAt: string | null
  movedServerIds: string[]
  pendingServerIds: string[]
  currentServerId: string | null
  stoppedReason: string | null
}

export function toApiRotation(state: RotationState | null): ApiRotation | null {
  if (!state) return null
  return {
    phase: state.phase,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? null,
    movedServerIds: state.moved,
    pendingServerIds: state.pending,
    currentServerId: state.current?.serverId ?? null,
    stoppedReason: state.stoppedReason ?? null,
  }
}

/** Is traffic still being given time to move onto the last moved server's connector? Pure. */
export function settling(state: RotationState, nowMs: number, settleMs: number): boolean {
  if (!state.lastConnectedAt) return false
  return nowMs - Date.parse(state.lastConnectedAt) < settleMs
}
