/**
 * Offline sweep — a single Cron Trigger (see `wrangler.jsonc` `triggers.crons`)
 * that closes the "hard poweroff never shows offline" gap: a daemon that
 * disappears without a clean WebSocket close (power loss, network partition,
 * kernel panic) leaves no `webSocketClose`/`webSocketError` event, so nothing
 * ever tells Postgres the server went away (see AGENTS.md → Daemon Cell →
 * "Presence model" disconnect-first trade-off).
 *
 * Design ("Option B"):
 *   1. One cheap Postgres read for servers Postgres currently believes are
 *      connected (`listConnectedServersForSweep`), plus recently-offline rows
 *      for self-heal (`listRecentlyOfflineServersForSweep`).
 *   2. Fan out a *read-only* liveness RPC to each candidate's Durable
 *      Object (`DaemonCell.checkLiveness`). It only inspects the free,
 *      runtime-tracked WebSocket auto-response timestamp — the same value
 *      the daemon's idle ping (`DAEMON_CELL_PING`) keeps warm — and never
 *      touches SQLite. A healthy server costs one Workers subrequest and
 *      nothing else.
 *   3. Stale connected servers get a Postgres write (reusing
 *      `onDaemonDisconnected`) and a notification. Live+warm servers that
 *      Postgres still marks offline get re-projected online via
 *      `onDaemonConnected` (self-heal).
 *
 * This intentionally does NOT reintroduce a per-DO recurring alarm — every
 * `setAlarm()` reschedule is a billed SQLite row write (see do.ts "Alarm /
 * hibernation" + AGENTS.md Daemon Cell billing model). Centralizing the
 * "when to check" clock into one Cron Trigger avoids that cost entirely and
 * scales with the number of *connected* servers, not the number of ticks.
 *
 * Detection latency: up to one cron interval (60s, Cloudflare's finest cron
 * granularity) plus `OFFLINE_SWEEP_STALE_MS` grace — worst case is close to
 * but a good deal cheaper than re-arming a DO alarm per server.
 */
import { endDbConnection, type Db } from "../../db.ts";
import { resolveWorkersDb } from "../../workers-bindings.ts";
import { createDurableObjectDaemonCellRegistry } from "./do-registry.ts";
import {
  onDaemonConnected,
  onDaemonDisconnected,
} from "./control-plane-monitor.ts";
import {
  type ConnectedServerForSweep,
  listConnectedServersForSweep,
  listRecentlyOfflineServersForSweep,
  rotateSweepBatch,
} from "./postgres-projection.ts";
import type { DaemonCellLiveness } from "./contracts.ts";

/** Grace beyond the daemon's ~60s idle-ping cadence before declaring a server stale. */
export const OFFLINE_SWEEP_STALE_MS = 90_000;

/** Stay comfortably under the Workers-paid subrequest ceiling (1000/invocation). */
export const MAX_SWEEP_FANOUT = 900;

/** Connected stale-check budget — remainder reserved for self-heal. */
export const CONNECTED_SWEEP_BUDGET = 700;

/** Recently-offline self-heal budget — not starved by connected rows. */
export const SELF_HEAL_SWEEP_BUDGET = MAX_SWEEP_FANOUT - CONNECTED_SWEEP_BUDGET;

/** Bound in-flight liveness RPCs per tick instead of bursting the whole batch at once. */
const FANOUT_CONCURRENCY = 25;

function sweepTrace(event: string, detail: Record<string, unknown> = {}): void {
  const parts = [`offline-sweep event=${event}`];
  for (const key of Object.keys(detail).sort((a, b) => a.localeCompare(b))) {
    const value = detail[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  console.info(parts.join(" "));
}

/**
 * Extension point for real delivery (email/webhook) once a target audience
 * exists — see AGENTS.md "eventually notify on server-down" note. For now
 * this only emits a greppable structured log line.
 */
function notifyServerWentOffline(serverId: string): void {
  sweepTrace("notify-offline", { serverId });
}

async function withBoundedConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

type SweepCandidate = {
  id: string;
  postgresConnected: boolean;
  connectedAt: string | null;
};

/**
 * Grace bookkeeping for connected sockets whose auto-response timestamp is
 * still null — bounded in-memory state only (never DO SQLite).
 */
const firstNullObservedAtMs = new Map<string, number>();

/** Test helper — clears null-grace bookkeeping between cases. */
export function resetOfflineSweepNullGraceForTests(): void {
  firstNullObservedAtMs.clear();
}

/** Records or clears the first-null observation timestamp for a server. */
export function updateNullGraceBookkeeping(
  serverId: string,
  liveness: DaemonCellLiveness | null,
  nowMs: number,
): void {
  if (!liveness?.connected) {
    firstNullObservedAtMs.delete(serverId);
    return;
  }
  if (liveness.lastPingAtMs !== null) {
    firstNullObservedAtMs.delete(serverId);
    return;
  }
  if (!firstNullObservedAtMs.has(serverId)) {
    firstNullObservedAtMs.set(serverId, nowMs);
  }
}

function pruneNullGraceBookkeeping(activeServerIds: ReadonlySet<string>): void {
  for (const serverId of firstNullObservedAtMs.keys()) {
    if (!activeServerIds.has(serverId)) {
      firstNullObservedAtMs.delete(serverId);
    }
  }
}

export function isStale(
  serverId: string,
  liveness: DaemonCellLiveness | null,
  nowMs: number,
  _connectedAt: string | null,
): boolean {
  if (!liveness?.connected) return true;
  if (liveness.lastPingAtMs !== null) {
    return nowMs - liveness.lastPingAtMs > OFFLINE_SWEEP_STALE_MS;
  }
  const firstNullAt = firstNullObservedAtMs.get(serverId);
  if (firstNullAt === undefined) return false;
  return nowMs - firstNullAt > OFFLINE_SWEEP_STALE_MS;
}

function isLiveAndWarm(
  liveness: DaemonCellLiveness | null,
  nowMs: number,
): boolean {
  if (!liveness?.connected) return false;
  if (liveness.lastPingAtMs === null) return false;
  return nowMs - liveness.lastPingAtMs <= OFFLINE_SWEEP_STALE_MS;
}

function mergeSweepCandidates(
  connected: ConnectedServerForSweep[],
  recentlyOffline: Array<{ id: string; connectedAt: string | null }>,
): SweepCandidate[] {
  const byId = new Map<string, SweepCandidate>();
  for (const candidate of connected) {
    byId.set(candidate.id, {
      id: candidate.id,
      postgresConnected: true,
      connectedAt: candidate.connectedAt,
    });
  }
  for (const candidate of recentlyOffline) {
    if (byId.has(candidate.id)) continue;
    byId.set(candidate.id, {
      id: candidate.id,
      postgresConnected: false,
      connectedAt: candidate.connectedAt,
    });
  }
  return [...byId.values()];
}

async function sweepOnce(env: CloudflareBindings, db: Db): Promise<void> {
  const nowMs = Date.now();
  const connected = await listConnectedServersForSweep(db);
  const recentlyOffline = await listRecentlyOfflineServersForSweep(db);
  const connectedBatch = rotateSweepBatch(
    connected,
    CONNECTED_SWEEP_BUDGET,
    nowMs,
  );
  const selfHealBatch = rotateSweepBatch(
    recentlyOffline,
    SELF_HEAL_SWEEP_BUDGET,
    nowMs,
  );
  const candidates = mergeSweepCandidates(connectedBatch, selfHealBatch);
  if (candidates.length === 0) return;

  const totalCandidates = connected.length + recentlyOffline.length;
  const truncated = totalCandidates > candidates.length;
  if (truncated) {
    sweepTrace("truncated", {
      total: totalCandidates,
      checked: candidates.length,
      connectedTotal: connected.length,
      connectedChecked: connectedBatch.length,
      selfHealTotal: recentlyOffline.length,
      selfHealChecked: selfHealBatch.length,
    });
  }

  const batch = candidates;

  const registry = createDurableObjectDaemonCellRegistry(env, db);
  const staleIds: string[] = [];
  const healIds: string[] = [];

  await withBoundedConcurrency(batch, FANOUT_CONCURRENCY, async (candidate) => {
    let liveness: DaemonCellLiveness | null = null;
    try {
      liveness = (await registry.getCell(candidate.id).checkLiveness?.()) ?? null;
    } catch (err) {
      sweepTrace("liveness-check-failed", {
        serverId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    updateNullGraceBookkeeping(candidate.id, liveness, nowMs);

    if (candidate.postgresConnected) {
      if (isStale(candidate.id, liveness, nowMs, candidate.connectedAt)) {
        staleIds.push(candidate.id);
      }
      return;
    }

    if (isLiveAndWarm(liveness, nowMs)) {
      healIds.push(candidate.id);
    }
  });

  if (staleIds.length > 0) {
    sweepTrace("stale-detected", { count: staleIds.length });

    await withBoundedConcurrency(staleIds, FANOUT_CONCURRENCY, async (serverId) => {
      try {
        await onDaemonDisconnected(db, serverId);
        notifyServerWentOffline(serverId);
      } catch (err) {
        sweepTrace("mark-offline-failed", {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  pruneNullGraceBookkeeping(new Set(batch.map((candidate) => candidate.id)));

  if (healIds.length === 0) return;

  sweepTrace("self-heal-detected", { count: healIds.length });

  await withBoundedConcurrency(healIds, FANOUT_CONCURRENCY, async (serverId) => {
    try {
      const cell = registry.getCell(serverId);
      await onDaemonConnected(db, serverId, cell);
    } catch (err) {
      sweepTrace("self-heal-failed", {
        serverId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Cron Trigger entry point (`workers.ts` `scheduled()`). */
export async function runOfflineSweep(env: CloudflareBindings): Promise<void> {
  const db = resolveWorkersDb(env);
  if (!db) return;

  try {
    await sweepOnce(env, db);
  } catch (err) {
    sweepTrace("sweep-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await endDbConnection(db);
  }
}
