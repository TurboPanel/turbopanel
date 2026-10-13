/**
 * Live deploy progress on the `command` row (`command.progress`).
 *
 * The daemon sends the whole step plan on every `command-progress` frame
 * (`CommandProgress`, `src/contracts/cell-protocol.ts`); the control plane
 * keeps the latest copy and, when the command ends, settles the steps the
 * daemon never got to report. Shared by both cell paths (`daemon/cell/do.ts`
 * and `daemon/deno-ws.ts`) and by the terminal transitions in
 * `command-records.ts`.
 */
import { and, eq, notInArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command } from '../../db/schema.ts'
import {
  type CommandProgress,
  type CommandProgressStep,
  type CommandProgressStepState,
  isCommandProgress,
} from '../../contracts/cell-protocol.ts'
import { nowIso } from './ids.ts'
import { type CommandStatus, TERMINAL_COMMAND_STATUSES } from './types.ts'

/**
 * The stored jsonb as a typed payload; `null` for anything that is not one.
 * A cheap shape check only: rows were validated in full on the way in
 * ({@link recordCommandProgress}), and this runs on every command read.
 */
export function parseStoredCommandProgress(value: unknown): CommandProgress | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const shaped =
    record.version === 1 &&
    Array.isArray(record.steps) &&
    (record.current === null || typeof record.current === 'string') &&
    typeof record.updatedAt === 'string'
  return shaped ? (value as CommandProgress) : null
}

/**
 * Re-build a validated payload from its known fields only, so a key this
 * build does not know never reaches the row or the client API.
 */
function normalizeCommandProgress(progress: CommandProgress): CommandProgress {
  return {
    version: 1,
    steps: progress.steps.map((step) => ({
      id: step.id,
      label: step.label,
      state: step.state,
      ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
      ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
      ...(step.detail === undefined ? {} : { detail: step.detail }),
    })),
    current: progress.current,
    updatedAt: progress.updatedAt,
  }
}

/**
 * What a step the daemon left `running` or `pending` becomes when the command
 * ends without a final report: a successful command finished everything, a
 * failed or timed-out one broke on the running step, a cancelled one simply
 * stopped.
 */
function settledState(
  state: CommandProgressStepState,
  status: CommandStatus
): CommandProgressStepState {
  if (state !== 'running' && state !== 'pending') return state
  if (status === 'succeeded') return 'done'
  if (state === 'pending' || status === 'cancelled') return 'skipped'
  return 'failed'
}

function settleStep(step: CommandProgressStep, status: CommandStatus, at: string) {
  const state = settledState(step.state, status)
  if (state === step.state) return step
  const settled: CommandProgressStep = { ...step, state }
  if (step.state === 'running' && settled.finishedAt === undefined) settled.finishedAt = at
  return settled
}

/**
 * Settle a progress payload for a command that reached `status`. Returns the
 * input itself when nothing changes, so callers can skip the write.
 */
export function finalizeCommandProgress(
  progress: CommandProgress,
  status: CommandStatus,
  at: string = nowIso()
): CommandProgress {
  if (!TERMINAL_COMMAND_STATUSES.has(status)) return progress
  const steps = progress.steps.map((step) => settleStep(step, status, at))
  const unchanged =
    progress.current === null && steps.every((step, index) => step === progress.steps[index])
  if (unchanged) return progress
  return { ...progress, steps, current: null, updatedAt: at }
}

export type RecordCommandProgressResult = 'stored' | 'invalid' | 'not-applied'

/**
 * Store a `command-progress` payload. One conditional update: the command
 * must belong to the attached server and must not have finished, so a late
 * frame can never reopen a terminal command or touch another server's row.
 * Best effort: a database error is reported as `not-applied`, never thrown,
 * because a progress frame must not fail the cell.
 */
export async function recordCommandProgress(
  db: Db,
  input: { serverId: string; commandId: string; progress: unknown }
): Promise<RecordCommandProgressResult> {
  if (!isCommandProgress(input.progress)) return 'invalid'
  const progress = normalizeCommandProgress(input.progress)
  try {
    const rows = await db
      .update(command)
      .set({ progress, updatedAt: nowIso() })
      .where(
        and(
          eq(command.id, input.commandId),
          eq(command.serverId, input.serverId),
          notInArray(command.status, [...TERMINAL_COMMAND_STATUSES])
        )
      )
      .returning({ id: command.id })
    return rows.length > 0 ? 'stored' : 'not-applied'
  } catch {
    return 'not-applied'
  }
}

/**
 * Settle the stored progress of a command that just reached `status` and
 * write it back when it changed. Returns the progress the record should
 * carry. Callers pass the `progress` column of the row the terminal update
 * returned; once the status is terminal no daemon frame can replace it.
 * Best effort: the transition has already committed, so a failed write-back
 * is logged and the settled plan is still returned, never thrown.
 */
export async function finalizeStoredCommandProgress(
  db: Db,
  input: { commandId: string; status: CommandStatus; progress: unknown; at: string }
): Promise<CommandProgress | null> {
  const stored = parseStoredCommandProgress(input.progress)
  if (stored === null) return null
  const finalized = finalizeCommandProgress(stored, input.status, input.at)
  if (finalized === stored) return stored
  try {
    await db
      .update(command)
      .set({ progress: finalized, updatedAt: input.at })
      .where(eq(command.id, input.commandId))
  } catch (err) {
    console.warn(
      `command-progress finalize failed (${input.commandId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  return finalized
}
