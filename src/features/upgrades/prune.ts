/**
 * Bounded prune of upgrade history. Home for this phase only — the
 * orchestrator module will own the rest of `src/features/upgrades/`.
 *
 * The orchestrator (not this file) writes `upgrade.counts` when a run
 * finishes. That summary is what history keeps after these deletes remove
 * old `upgradestep` rows.
 *
 * Three capped deletes per call, oldest first, same shape as
 * `sweepExpiredCommandDispatch` / `sweepExpiredWebhookDeliveries`:
 * - `done` / `skipped` steps older than `doneRetentionDays`
 *   (env `TURBOPANEL_UPGRADE_STEP_RETENTION_DAYS`, default 14)
 *   whose parent run is terminal and already has `counts`
 * - `failed` / `rolled_back` / `needs_attention` steps older than 90 days
 *   with the same parent-run requirement, so an active fleet run keeps its
 *   completed steps until the summary is written
 * - terminal `upgrade` rows older than 365 days, except the newest 50
 *
 * Returns counts for the caller to trace. No logger of its own.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../../db/connection.ts";
import { upgrade, upgradeStep } from "../../db/schema.ts";
import {
  UPGRADE_STEP_DONE_STATUSES,
  UPGRADE_STEP_FAILURE_STATUSES,
  UPGRADE_TERMINAL_STATUSES,
} from "./vocabulary.ts";

/** Default age of a `done` / `skipped` step before it can be deleted. */
export const UPGRADE_STEP_DONE_RETENTION_DAYS = 14;

/** Age of a failed step before it can be deleted. */
export const UPGRADE_STEP_FAILURE_RETENTION_DAYS = 90;

/** Age of a terminal run before it can be deleted. */
export const UPGRADE_RUN_RETENTION_DAYS = 365;

/** Newest runs kept even when they are older than {@link UPGRADE_RUN_RETENTION_DAYS}. */
export const UPGRADE_RUN_KEEP_NEWEST = 50;

/** Rows removed per delete inside one call. */
export const UPGRADE_PRUNE_BATCH_LIMIT = 200;

const PRUNE_LIMIT_MAX = 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type UpgradePruneCounts = {
  doneSteps: number;
  failedSteps: number;
  runs: number;
};

export type PruneUpgradeHistoryOpts = {
  limit?: number;
  now?: string;
  doneRetentionDays?: number;
  failureRetentionDays?: number;
  runRetentionDays?: number;
  keepNewestRuns?: number;
};

/** Clamp a batch cap the way the other maintenance sweeps do. */
export function clampUpgradePruneLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), PRUNE_LIMIT_MAX);
}

/**
 * Parse `TURBOPANEL_UPGRADE_STEP_RETENTION_DAYS`. Blank or out of range
 * falls back to {@link UPGRADE_STEP_DONE_RETENTION_DAYS}.
 */
export function parseUpgradeStepRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return UPGRADE_STEP_DONE_RETENTION_DAYS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    return UPGRADE_STEP_DONE_RETENTION_DAYS;
  }
  return parsed;
}

function cutoffIso(now: string, days: number): string {
  return new Date(Date.parse(now) - days * MS_PER_DAY).toISOString();
}

function quotedList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

async function deleteOldSteps(
  db: Db,
  statuses: readonly string[],
  cutoff: string,
  limit: number,
): Promise<number> {
  const deleted = await db
    .delete(upgradeStep)
    .where(
      sql`${upgradeStep.id} in (
        select step.id from ${upgradeStep} step
        inner join ${upgrade} parent on parent.id = step.upgrade_id
        where step.status in (${sql.raw(quotedList(statuses))})
          and step.updated_at < ${cutoff}::timestamptz
          and parent.status in (${
        sql.raw(quotedList(UPGRADE_TERMINAL_STATUSES))
      })
          and parent.counts is not null
        order by step.updated_at
        limit ${limit}
      )`,
    )
    .returning({ id: upgradeStep.id });
  return deleted.length;
}

async function deleteOldRuns(
  db: Db,
  cutoff: string,
  limit: number,
  keepNewest: number,
): Promise<number> {
  const deleted = await db
    .delete(upgrade)
    .where(
      sql`${upgrade.id} in (
        select id from ${upgrade}
        where status in (${sql.raw(quotedList(UPGRADE_TERMINAL_STATUSES))})
          and created_at < ${cutoff}::timestamptz
          and id not in (
            select id from ${upgrade}
            order by created_at desc
            limit ${keepNewest}
          )
        order by created_at
        limit ${limit}
      )`,
    )
    .returning({ id: upgrade.id });
  return deleted.length;
}

/**
 * Delete aged step rows and aged terminal runs, each capped at `limit`.
 */
export async function pruneUpgradeHistory(
  db: Db,
  opts: PruneUpgradeHistoryOpts = {},
): Promise<UpgradePruneCounts> {
  const limit = clampUpgradePruneLimit(opts.limit ?? UPGRADE_PRUNE_BATCH_LIMIT);
  const now = opts.now ?? new Date().toISOString();
  const doneDays = opts.doneRetentionDays ?? UPGRADE_STEP_DONE_RETENTION_DAYS;
  const failureDays = opts.failureRetentionDays ??
    UPGRADE_STEP_FAILURE_RETENTION_DAYS;
  const runDays = opts.runRetentionDays ?? UPGRADE_RUN_RETENTION_DAYS;
  const keepNewest = opts.keepNewestRuns ?? UPGRADE_RUN_KEEP_NEWEST;

  const doneSteps = await deleteOldSteps(
    db,
    UPGRADE_STEP_DONE_STATUSES,
    cutoffIso(now, doneDays),
    limit,
  );
  const failedSteps = await deleteOldSteps(
    db,
    UPGRADE_STEP_FAILURE_STATUSES,
    cutoffIso(now, failureDays),
    limit,
  );
  const runs = await deleteOldRuns(
    db,
    cutoffIso(now, runDays),
    limit,
    keepNewest,
  );
  return { doneSteps, failedSteps, runs };
}
