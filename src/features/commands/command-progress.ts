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
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command } from '../../db/schema.ts'
import {
  type CommandProgress,
  type CommandProgressStep,
  type CommandProgressStepState,
  isCommandProgress,
} from '../../contracts/cell-protocol.ts'
import { shiftedRunningSince } from './deploy-limits.ts'
import { nowIso } from './ids.ts'
import { type CommandStatus, TERMINAL_COMMAND_STATUSES } from './types.ts'

/**
 * The stored step plan: what the daemon sent plus one panel-only field.
 * `contactLostAt` is the time the server was last heard from, set while a
 * running command has gone quiet and the control plane is checking with the
 * server. It is never sent by a daemon, and the next frame (or a report that
 * lists the command as running) replaces the plan and so clears it.
 */
export type StoredCommandProgress = CommandProgress & { contactLostAt?: string | null }

/**
 * The stored jsonb as a typed payload; `null` for anything that is not one.
 * A cheap shape check only: rows were validated in full on the way in
 * ({@link recordCommandProgress}), and this runs on every command read.
 */
export function parseStoredCommandProgress(value: unknown): StoredCommandProgress | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const shaped =
    record.version === 1 &&
    Array.isArray(record.steps) &&
    (record.current === null || typeof record.current === 'string') &&
    typeof record.updatedAt === 'string'
  return shaped ? (value as StoredCommandProgress) : null
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
    ...(progress.runningSince === undefined ? {} : { runningSince: progress.runningSince }),
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
  const stillChecking = (progress as StoredCommandProgress).contactLostAt != null
  const unchanged =
    progress.current === null &&
    !stillChecking &&
    steps.every((step, index) => step === progress.steps[index])
  if (unchanged) return progress
  const { contactLostAt: _checking, ...rest } = progress as StoredCommandProgress
  return { ...rest, steps, current: null, updatedAt: at }
}

/**
 * The run clock after a gap in the server's reports: time the server was not
 * heard from does not count against the deploy's time limit.
 */
function movedRunningSince(
  before: string,
  lastHeardAt: string | undefined,
  receivedAt: string
): string {
  return (
    shiftedRunningSince({
      runningSince: before,
      lastHeardMs: lastHeardAt === undefined ? null : toEpochMs(lastHeardAt),
      nowMs: Date.parse(receivedAt),
    }) ?? before
  )
}

function toEpochMs(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
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
    const receivedAt = nowIso()
    // The deploy's run clock is the control plane's own: the server only says
    // "running" or "waiting", and the time it started is when that was first
    // heard, so a wrong clock on the server cannot stretch or shorten the cap.
    if (typeof progress.runningSince === 'string') {
      const [previous] = await db
        .select({ progress: command.progress, updatedAt: command.updatedAt })
        .from(command)
        .where(and(eq(command.id, input.commandId), eq(command.serverId, input.serverId)))
        .limit(1)
      const before = parseStoredCommandProgress(previous?.progress)?.runningSince
      progress.runningSince =
        typeof before === 'string'
          ? movedRunningSince(before, previous?.updatedAt, receivedAt)
          : receivedAt
    }
    const rows = await db
      .update(command)
      .set({
        progress,
        updatedAt: receivedAt,
        // The first time the server says it is running, that is when the
        // command started; waiting for the host afterwards does not undo it.
        ...(typeof progress.runningSince === 'string'
          ? {
              startedAt: sql`COALESCE(${command.startedAt}, ${progress.runningSince}::timestamptz)`,
            }
          : {}),
      })
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

/**
 * The server says it is still carrying this command (a `commands.running`
 * report on `hello` / `heartbeat`): count it as heard from now. Clears the
 * "checking with the server" mark and gives back the quiet time on the run
 * clock. Best effort, like {@link recordCommandProgress}.
 */
export async function noteCommandAlive(
  db: Db,
  input: { serverId: string; commandId: string }
): Promise<'noted' | 'not-applied'> {
  try {
    const receivedAt = nowIso()
    const [row] = await db
      .select({ progress: command.progress, updatedAt: command.updatedAt })
      .from(command)
      .where(
        and(
          eq(command.id, input.commandId),
          eq(command.serverId, input.serverId),
          notInArray(command.status, [...TERMINAL_COMMAND_STATUSES])
        )
      )
      .limit(1)
    if (!row) return 'not-applied'
    const stored = parseStoredCommandProgress(row.progress)
    const progress =
      stored === null
        ? row.progress
        : aliveProgress(stored, toEpochMs(row.updatedAt), Date.parse(receivedAt))
    const rows = await db
      .update(command)
      .set({ progress, updatedAt: receivedAt })
      .where(
        and(
          eq(command.id, input.commandId),
          eq(command.serverId, input.serverId),
          notInArray(command.status, [...TERMINAL_COMMAND_STATUSES])
        )
      )
      .returning({ id: command.id })
    return rows.length > 0 ? 'noted' : 'not-applied'
  } catch {
    return 'not-applied'
  }
}

function aliveProgress(
  stored: StoredCommandProgress,
  lastHeardMs: number | null,
  nowMs: number
): StoredCommandProgress {
  const { contactLostAt: _checking, ...rest } = stored
  const runningSince = shiftedRunningSince({
    runningSince: stored.runningSince,
    lastHeardMs,
    nowMs,
  })
  return runningSince === null ? rest : { ...rest, runningSince }
}

/**
 * Mark a running command as "checking with the server": the control plane has
 * not heard from it for a while and does not know how it ended. One conditional
 * update that leaves `updated_at` alone, because that column is the clock of
 * the silence. Returns whether the mark was newly set.
 */
export async function markCommandContactLost(
  db: Db,
  input: { commandId: string; lastHeardAt: string }
): Promise<boolean> {
  try {
    const rows = await db
      .update(command)
      .set({
        progress: sql`${command.progress} || ${JSON.stringify({ contactLostAt: input.lastHeardAt })}::jsonb`,
        updatedAt: sql`${command.updatedAt}`,
      })
      .where(
        and(
          eq(command.id, input.commandId),
          notInArray(command.status, [...TERMINAL_COMMAND_STATUSES]),
          sql`${command.progress} is not null`,
          sql`${command.progress}->>'contactLostAt' is null`
        )
      )
      .returning({ id: command.id })
    return rows.length > 0
  } catch {
    return false
  }
}
