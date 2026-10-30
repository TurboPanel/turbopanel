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
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
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
          notInArray(command.status, [...TERMINAL_COMMAND_STATUSES]),
          // Frames are handled on separate connections, so one sent earlier can
          // finish later. A frame older than the stored plan is dropped, which
          // keeps a finished step's note from being overwritten by the frame
          // that was sent while the step was still running.
          sql`COALESCE((${command.progress}->>'updatedAt')::timestamptz, '-infinity'::timestamptz) <= ${progress.updatedAt}::timestamptz`
        )
      )
      .returning({ id: command.id })
    if (rows.length > 0) return 'stored'
    return await keepLateStepNotes(db, input, progress, receivedAt)
  } catch {
    return 'not-applied'
  }
}

/**
 * The command already ended, so the frame cannot replace its plan. Both ends
 * share one connection but the control plane handles each frame on its own, so
 * the result can commit before the last frame (the one carrying a finished
 * step's note) is stored. Copy only what the settled plan lost: the note and
 * times of a step the frame reports finished (a finished step's note replaces the live line it showed while it ran). Everything else, the states and
 * the outcome, stays as the terminal transition settled it, and a frame that
 * adds nothing (an older one, another server's) changes nothing.
 */
async function keepLateStepNotes(
  db: Db,
  input: { serverId: string; commandId: string },
  progress: CommandProgress,
  receivedAt: string
): Promise<RecordCommandProgressResult> {
  const [row] = await db
    .select({ progress: command.progress, status: command.status })
    .from(command)
    .where(and(eq(command.id, input.commandId), eq(command.serverId, input.serverId)))
    .limit(1)
  if (!row || !TERMINAL_COMMAND_STATUSES.has(row.status as CommandStatus)) return 'not-applied'
  const stored = parseStoredCommandProgress(row.progress)
  if (stored === null) return 'not-applied'
  let changed = false
  const steps = stored.steps.map((step) => {
    const late = progress.steps.find((item) => item.id === step.id)
    if (late === undefined || late.detail === undefined || late.detail === step.detail) return step
    if (late.state !== 'done' && late.state !== 'failed' && late.state !== 'skipped') return step
    changed = true
    return {
      ...step,
      detail: late.detail,
      ...(step.finishedAt === undefined && late.finishedAt !== undefined
        ? { finishedAt: late.finishedAt }
        : {}),
    }
  })
  if (!changed) return 'not-applied'
  const merged = finalizeCommandProgress(
    { ...stored, steps, updatedAt: receivedAt },
    row.status as CommandStatus,
    receivedAt
  )
  // Leaves the command's own `updated_at` alone; a write that raced with
  // another late frame or with the terminal settle loses and is dropped.
  const rows = await db
    .update(command)
    .set({ progress: merged })
    .where(
      and(
        eq(command.id, input.commandId),
        eq(command.serverId, input.serverId),
        inArray(command.status, [...TERMINAL_COMMAND_STATUSES]),
        sql`${command.progress}->>'updatedAt' = ${stored.updatedAt}`
      )
    )
    .returning({ id: command.id })
  return rows.length > 0 ? 'stored' : 'not-applied'
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
      .where(
        and(
          eq(command.id, input.commandId),
          // A late frame that stored a step note in between already settled
          // the plan itself; writing the older settled copy would drop it.
          sql`${command.progress}->>'updatedAt' = ${stored.updatedAt}`
        )
      )
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
