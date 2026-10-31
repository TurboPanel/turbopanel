/**
 * How the last `server.fabric.reconcile` sent to a server ended, kept in
 * `relay.metadata.reconcile` so the fabric page can say what each server
 * really did: a pause is only "down" once that server confirmed it, a failed
 * command shows the daemon's own message, and an apply that worked shows what
 * it had to leave out (the daemon's `warnings`).
 *
 * Written when the command is queued (`pending`) and again when it finishes.
 * A finish only lands on the command it belongs to, so a late result of an
 * older command never overwrites a newer one. Never hashed into the desired
 * reconcile state.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { relay } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { nowIso } from '../commands/ids.ts'
import { lastErrorLine } from '../commands/error-line.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import type { FabricReconcileCommandPayload } from '../../contracts/commands/schemas.ts'

/** What the command asked for: bring up, pause (keep keys) or remove. */
export type FabricReconcileAction = 'apply' | 'pause' | 'remove'

export type FabricReconcileOutcome = {
  commandId: string
  action: FabricReconcileAction
  state: 'pending' | 'done' | 'failed'
  at: string
  /** The daemon's error (its last useful line), for a failed command. */
  error?: string
  /** What an apply that worked left out. */
  warnings?: string[]
}

export function fabricReconcileAction(
  payload: FabricReconcileCommandPayload
): FabricReconcileAction {
  if (payload.enabled) return 'apply'
  return payload.retainKeys === true ? 'pause' : 'remove'
}

const STATES = new Set(['pending', 'done', 'failed'])
const ACTIONS = new Set(['apply', 'pause', 'remove'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored outcome, or `null` when the row has none (or a malformed one). */
export function readFabricReconcileOutcome(metadata: unknown): FabricReconcileOutcome | null {
  if (!isRecord(metadata)) return null
  const raw = metadata.reconcile
  if (!isRecord(raw)) return null
  const { commandId, action, state, at, error, warnings } = raw
  if (typeof commandId !== 'string' || typeof at !== 'string') return null
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null
  if (typeof state !== 'string' || !STATES.has(state)) return null
  const outcome: FabricReconcileOutcome = {
    commandId,
    action: action as FabricReconcileAction,
    state: state as FabricReconcileOutcome['state'],
    at,
  }
  if (typeof error === 'string' && error.length > 0) outcome.error = error
  if (Array.isArray(warnings)) {
    const kept = warnings.filter((entry): entry is string => typeof entry === 'string')
    if (kept.length > 0) outcome.warnings = kept
  }
  return outcome
}

/** Best effort: a failed write is logged, never a reason to fail the command. */
async function writeOutcome(
  db: Db,
  serverId: string,
  build: (current: FabricReconcileOutcome | null) => FabricReconcileOutcome | null
): Promise<void> {
  try {
    await writeOutcomeRows(db, serverId, build)
  } catch (err) {
    compatLogWarn(
      'fabric-reconcile-outcome',
      `could not record the reconcile outcome for server ${serverId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

async function writeOutcomeRows(
  db: Db,
  serverId: string,
  build: (current: FabricReconcileOutcome | null) => FabricReconcileOutcome | null
): Promise<void> {
  const rows = await db
    .select({ relayId: relay.id, metadata: relay.metadata })
    .from(relay)
    .where(eq(relay.serverId, serverId))
  await forEachSequential(rows, async (row) => {
    const next = build(readFabricReconcileOutcome(row.metadata))
    if (!next) return
    const base = isRecord(row.metadata) ? row.metadata : {}
    await db
      .update(relay)
      .set({ metadata: { ...base, reconcile: next }, updatedAt: nowIso() })
      .where(and(eq(relay.id, row.relayId), eq(relay.serverId, serverId)))
  })
}

/** A reconcile was queued for this server: it is pending until it answers. */
export async function stampFabricReconcilePending(
  db: Db,
  params: { serverId: string; commandId: string; action: FabricReconcileAction }
): Promise<void> {
  await writeOutcome(db, params.serverId, () => ({
    commandId: params.commandId,
    action: params.action,
    state: 'pending',
    at: nowIso(),
  }))
}

/**
 * The command finished. Only the command the row is waiting for (or a row
 * that waits for none) is updated.
 */
export async function stampFabricReconcileFinished(
  db: Db,
  params: {
    serverId: string
    commandId: string
    action: FabricReconcileAction
    ok: boolean
    error?: string | null
    warnings?: readonly string[]
  }
): Promise<void> {
  await writeOutcome(db, params.serverId, (current) => {
    if (current && current.commandId !== params.commandId) return null
    const outcome: FabricReconcileOutcome = {
      commandId: params.commandId,
      action: params.action,
      state: params.ok ? 'done' : 'failed',
      at: nowIso(),
    }
    const error = params.ok ? null : lastErrorLine(params.error)
    if (!params.ok) outcome.error = error ?? 'The server did not say why.'
    if (params.ok && params.warnings && params.warnings.length > 0) {
      outcome.warnings = [...params.warnings]
    }
    return outcome
  })
}
