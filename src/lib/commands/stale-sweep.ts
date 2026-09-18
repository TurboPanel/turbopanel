/**
 * Stale-command recovery sweep.
 *
 * Per-type command timeouts are enforced only in the consumer's memory
 * (`waitForRequest` budget). When the control plane restarts mid-command — or
 * a daemon is restarted mid-run and never reports an outcome — that in-memory
 * wait dies with the process and the command row is stranded in a
 * non-terminal status forever. A `managed` row left at `'applying'` then
 * rejects every later PATCH/apply with `managed_busy` (409) and there is no
 * recovery path short of manual SQL.
 *
 * This sweep runs on the shared maintenance cadence (Deno `runCleanup` lane;
 * Workers offline-sweep cron) and:
 *  1. transitions non-terminal commands past their per-type budget plus
 *     {@link STALE_COMMAND_GRACE_MS} to `timed_out` — the same terminal
 *     status the consumer would have set had it survived;
 *  2. releases `managed` rows stuck at `'applying'` that no longer have any
 *     live command, flipping them to `'failed'` so apply/settings unblock
 *     (the UI error surface reads the timed-out command rows via
 *     `last-error.ts`).
 *
 * The deadline is measured from the row's most recent lifecycle timestamp,
 * so a legitimately long-running command (e.g. a 30-minute backup) is only
 * swept after its own budget + grace — the moment a live consumer would have
 * timed it out anyway.
 */

import { and, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { command, managed } from "../db/schema.ts";
import { transitionCommand } from "../db/command-records.ts";
import { nowIso } from "./ids.ts";
import { commandTimeoutMs } from "./consumer.ts";
import { COMMAND_STATUSES, TERMINAL_COMMAND_STATUSES } from "./types.ts";

/** Extra slack past the consumer budget before a row counts as stranded. */
export const STALE_COMMAND_GRACE_MS = 5 * 60_000;

/** Bounded rows per tick — leftovers are picked up next tick. */
export const STALE_COMMAND_SWEEP_LIMIT = 50;

const NON_TERMINAL_STATUSES = COMMAND_STATUSES.filter(
  (status) => !TERMINAL_COMMAND_STATUSES.has(status),
);

export type StaleCommandCandidate = {
  id: string;
  /** Command type (`command.name` column). */
  name: string;
  createdAt: string;
  queuedAt: string | null;
  dispatchStartedAt: string | null;
  sentAt: string | null;
  ackedAt: string | null;
  startedAt: string | null;
};

function toMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure deadline check: the row is stale when its most recent lifecycle
 * timestamp is older than the per-type consumer budget plus grace.
 */
export function isStaleCommand(
  row: StaleCommandCandidate,
  nowMs: number,
  graceMs = STALE_COMMAND_GRACE_MS,
): boolean {
  const reference = toMs(row.startedAt) ??
    toMs(row.ackedAt) ??
    toMs(row.sentAt) ??
    toMs(row.dispatchStartedAt) ??
    toMs(row.queuedAt) ??
    toMs(row.createdAt);
  if (reference === null) return false;
  return nowMs >= reference + commandTimeoutMs(row.name) + graceMs;
}

/**
 * Did the daemon ever have this command?
 *
 * The distinction a re-drive needs (`daemon-deploy-resume`): a command the
 * daemon never acknowledged did nothing on the host, so re-issuing it is
 * free. One it acknowledged may still be running there — a second
 * `environment.deploy` would race a build that is quietly still going, which
 * is worse than the stall. `ackedAt`/`startedAt` are written from the
 * daemon's own frames, so their absence is the honest answer to "did it
 * arrive"; `sentAt` only says the control plane put it on the wire.
 */
export function daemonEverHadCommand(row: StaleCommandCandidate): boolean {
  return row.ackedAt !== null || row.startedAt !== null;
}

/**
 * Why a stalled command stalled, in a form the operator and any later
 * re-drive can act on rather than having to re-derive.
 */
export const STALLED_UNDELIVERED_ERROR_CODE = "stalled_undelivered";
export const STALLED_IN_FLIGHT_ERROR_CODE = "stalled";

/**
 * Transition stranded non-terminal commands to `timed_out`. Returns the
 * number of rows transitioned.
 */
export async function sweepStaleCommands(
  db: Db,
  opts?: { limit?: number; now?: number; graceMs?: number },
): Promise<number> {
  const limit = Math.min(
    Math.max(opts?.limit ?? STALE_COMMAND_SWEEP_LIMIT, 1),
    200,
  );
  const nowMs = opts?.now ?? Date.now();
  const graceMs = opts?.graceMs ?? STALE_COMMAND_GRACE_MS;

  // Cheap pre-filter: nothing younger than the grace window can be stale for
  // any type, and `updated_at` is bumped on every status transition.
  const cutoff = new Date(nowMs - graceMs).toISOString();
  const candidates = await db
    .select({
      id: command.id,
      name: command.name,
      createdAt: command.createdAt,
      queuedAt: command.queuedAt,
      dispatchStartedAt: command.dispatchStartedAt,
      sentAt: command.sentAt,
      ackedAt: command.ackedAt,
      startedAt: command.startedAt,
    })
    .from(command)
    .where(
      and(
        inArray(command.status, NON_TERMINAL_STATUSES),
        lt(command.updatedAt, cutoff),
      ),
    )
    .limit(limit);

  let swept = 0;
  for (const row of candidates) {
    if (!isStaleCommand(row, nowMs, graceMs)) continue;
    // Two different situations, and the operator's next move differs:
    // re-issuing an undelivered command is free, while re-issuing one the
    // daemon acknowledged may race work still running on the host.
    const delivered = daemonEverHadCommand(row);
    const record = await transitionCommand(db, row.id, {
      status: "timed_out",
      errorCode: delivered
        ? STALLED_IN_FLIGHT_ERROR_CODE
        : STALLED_UNDELIVERED_ERROR_CODE,
      error: delivered
        ? "command stalled: the daemon acknowledged it but never reported an outcome (control plane or daemon restarted mid-run). It may still be running on the host — check before re-running."
        : "command stalled: the daemon never acknowledged it, so nothing ran on the host. Safe to run again.",
    });
    if (record) swept += 1;
  }
  return swept;
}

/**
 * Flip `managed` rows stuck at `'applying'` with no remaining live command to
 * `'failed'` so PATCH/apply stop 409ing. Returns the released managed ids.
 */
export async function releaseStuckManagedApplying(
  db: Db,
  opts?: { now?: number; graceMs?: number },
): Promise<string[]> {
  const nowMs = opts?.now ?? Date.now();
  const graceMs = opts?.graceMs ?? STALE_COMMAND_GRACE_MS;
  const cutoff = new Date(nowMs - graceMs).toISOString();

  const rows = await db
    .update(managed)
    .set({ status: "failed", updatedAt: nowIso() })
    .where(
      and(
        eq(managed.status, "applying"),
        lt(managed.updatedAt, cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(command)
            .where(
              and(
                inArray(command.status, NON_TERMINAL_STATUSES),
                sql`${command.context}->>'managedId' = ${managed.id}::text`,
              ),
            ),
        ),
      ),
    )
    .returning({ id: managed.id });

  return rows.map((row) => row.id);
}
