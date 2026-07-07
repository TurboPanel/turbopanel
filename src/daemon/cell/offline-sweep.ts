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
 *      connected (`listConnectedServersForSweep`).
 *   2. Fan out a *read-only* liveness RPC to each server's own Durable
 *      Object (`DaemonCell.checkLiveness`). It only inspects the free,
 *      runtime-tracked WebSocket auto-response timestamp — the same value
 *      the daemon's idle ping (`DAEMON_CELL_PING`) keeps warm — and never
 *      touches SQLite. A healthy server costs one Workers subrequest and
 *      nothing else.
 *   3. Only servers that are actually stale get a Postgres write (reusing
 *      the existing `onDaemonDisconnected` projection) and a notification.
 *      Healthy servers cost zero writes.
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
import { onDaemonDisconnected } from "./control-plane-monitor.ts";
import {
  type ConnectedServerForSweep,
  listConnectedServersForSweep,
} from "./postgres-projection.ts";
import type { DaemonCellLiveness } from "./contracts.ts";

/** Grace beyond the daemon's ~60s idle-ping cadence before declaring a server stale. */
export const OFFLINE_SWEEP_STALE_MS = 90_000;

/** Stay comfortably under the Workers-paid subrequest ceiling (1000/invocation). */
const MAX_SWEEP_FANOUT = 900;

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

function isStale(
  candidate: ConnectedServerForSweep,
  liveness: DaemonCellLiveness | null,
  nowMs: number,
): boolean {
  if (!liveness?.connected) return true;
  if (liveness.lastPingAtMs !== null) {
    return nowMs - liveness.lastPingAtMs > OFFLINE_SWEEP_STALE_MS;
  }
  // No auto-response ping observed yet this wake — fall back to connectedAt so a
  // freshly-attached socket gets grace instead of failing on its first sweep tick.
  const connectedAtMs = candidate.connectedAt
    ? Date.parse(candidate.connectedAt)
    : Number.NaN;
  if (Number.isNaN(connectedAtMs)) return false;
  return nowMs - connectedAtMs > OFFLINE_SWEEP_STALE_MS;
}

async function sweepOnce(env: CloudflareBindings, db: Db): Promise<void> {
  const candidates = await listConnectedServersForSweep(db);
  if (candidates.length === 0) return;

  const truncated = candidates.length > MAX_SWEEP_FANOUT;
  const batch = truncated ? candidates.slice(0, MAX_SWEEP_FANOUT) : candidates;
  if (truncated) {
    sweepTrace("truncated", { total: candidates.length, checked: batch.length });
  }

  const registry = createDurableObjectDaemonCellRegistry(env, db);
  const nowMs = Date.now();
  const staleIds: string[] = [];

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
    if (isStale(candidate, liveness, nowMs)) {
      staleIds.push(candidate.id);
    }
  });

  if (staleIds.length === 0) return;

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
