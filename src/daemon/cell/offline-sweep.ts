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
 *      Postgres still marks offline get re-projected online (self-heal):
 *      AE-active candidates via Postgres-only `onDaemonConnectedFromEvidence`
 *      (no DO wake) only when the AE latest sample is newer than the offline
 *      transition; otherwise probed candidates via `onDaemonConnected` after
 *      `checkLiveness` already woke the cell.
 *
 * Cost model (AE short-circuit): **one fleet-wide Analytics Engine SQL read
 * per tick replaces N per-minute DO wakes**. Connected servers present in
 * the recent-host-sample set are provably alive — skip `checkLiveness`
 * entirely (zero subrequests). Suspects (absent from AE) keep the existing
 * check → demote path. AE-active recently-offline self-heal is also wake-free
 * (Postgres-only projection). When AE config is missing or the query throws,
 * fall back to today's check-all behavior so offline detection is never lost.
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
import { type Db, endDbConnection } from "../../db.ts";
import { resolveWorkersDb } from "../../workers-bindings.ts";
import { createDurableObjectDaemonCellRegistry } from "./do-registry.ts";
import {
  onDaemonConnected,
  onDaemonConnectedFromEvidence,
  onDaemonDisconnected,
} from "./control-plane-monitor.ts";
import {
  type ConnectedServerForSweep,
  listConnectedServersForSweep,
  listRecentlyOfflineServersForSweep,
  type RecentlyOfflineServerForSweep,
  rotateSweepBatch,
} from "./postgres-projection.ts";
import type {
  DaemonCell,
  DaemonCellLiveness,
  DaemonCellRegistry,
} from "./contracts.ts";
import { resolveAnalyticsEngineSqlConfig } from "../metrics/store-selection.ts";
import {
  AE_LIVENESS_WINDOW_SECONDS,
  queryRecentlyActiveServerIds,
} from "../metrics/analytics-engine/sql-api.ts";

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
    parts.push(
      `${key}=${
        typeof value === "object" ? JSON.stringify(value) : String(value)
      }`,
    );
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
  recentlyOffline: RecentlyOfflineServerForSweep[],
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

/**
 * AE-direct self-heal is only safe when the latest host sample is strictly
 * newer than the offline transition. A sample written shortly before a clean
 * `webSocketClose` stays inside the 180s AE window and must not undo a correct
 * offline projection without `checkLiveness`.
 */
export function canDirectHealFromAeEvidence(
  offlineAt: string,
  latestSampleAtMs: number | undefined,
): boolean {
  if (latestSampleAtMs === undefined) return false;
  const offlineAtMs = Date.parse(offlineAt);
  if (!Number.isFinite(offlineAtMs)) return false;
  return latestSampleAtMs > offlineAtMs;
}

/**
 * Resolve the AE recently-active serverId → latestAtMs map for this cron tick.
 * Returns `null` when AE is unavailable or the query fails — callers must
 * fall back to check-all so offline detection is never lost.
 */
async function resolveRecentlyActiveServerIds(
  env: CloudflareBindings,
): Promise<Map<string, number> | null> {
  const config = resolveAnalyticsEngineSqlConfig(env);
  if (!config) {
    sweepTrace("ae-unavailable");
    return null;
  }
  try {
    return await queryRecentlyActiveServerIds(config, {
      sinceSeconds: AE_LIVENESS_WINDOW_SECONDS,
    });
  } catch (err) {
    sweepTrace("ae-query-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export type SweepOnceDeps = {
  registry?: DaemonCellRegistry;
  /** serverId → latest AE host-sample epoch ms; null = AE unavailable. */
  resolveActiveServerIds?: () => Promise<Map<string, number> | null>;
  listConnected?: (db: Db) => Promise<ConnectedServerForSweep[]>;
  listRecentlyOffline?: (
    db: Db,
  ) => Promise<RecentlyOfflineServerForSweep[]>;
  onConnected?: (
    db: Db,
    serverId: string,
    cell: DaemonCell,
  ) => Promise<unknown>;
  /** Postgres-only AE-direct self-heal — must not touch a DaemonCell. */
  onConnectedFromEvidence?: (
    db: Db,
    serverId: string,
    connectedAt?: string | null,
  ) => Promise<unknown>;
  onDisconnected?: (db: Db, serverId: string) => Promise<unknown>;
};

async function probeCandidates(
  batch: SweepCandidate[],
  registry: DaemonCellRegistry,
  nowMs: number,
): Promise<{ staleIds: string[]; healIds: string[] }> {
  const staleIds: string[] = [];
  const healIds: string[] = [];

  await withBoundedConcurrency(batch, FANOUT_CONCURRENCY, async (candidate) => {
    let liveness: DaemonCellLiveness | null = null;
    try {
      // Half-open reaping still runs inside `/rpc/liveness` (`#reapUnhealthySockets`)
      // for the suspects we still wake; the absolute max-age backstop moves
      // daemon-side in a later phase.
      liveness = (await registry.getCell(candidate.id).checkLiveness?.()) ??
        null;
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

  return { staleIds, healIds };
}

async function demoteStale(
  db: Db,
  staleIds: string[],
  onDisconnected: (db: Db, serverId: string) => Promise<unknown>,
): Promise<void> {
  if (staleIds.length === 0) return;

  sweepTrace("stale-detected", { count: staleIds.length });

  await withBoundedConcurrency(
    staleIds,
    FANOUT_CONCURRENCY,
    async (serverId) => {
      try {
        await onDisconnected(db, serverId);
        notifyServerWentOffline(serverId);
      } catch (err) {
        sweepTrace("mark-offline-failed", {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

async function healServers(
  db: Db,
  healIds: string[],
  registry: DaemonCellRegistry,
  onConnected: (
    db: Db,
    serverId: string,
    cell: DaemonCell,
  ) => Promise<unknown>,
): Promise<void> {
  if (healIds.length === 0) return;

  sweepTrace("self-heal-detected", { count: healIds.length });

  await withBoundedConcurrency(
    healIds,
    FANOUT_CONCURRENCY,
    async (serverId) => {
      try {
        const cell = registry.getCell(serverId);
        await onConnected(db, serverId, cell);
      } catch (err) {
        sweepTrace("self-heal-failed", {
          serverId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

/** AE-direct self-heal: Postgres-only — never resolves a cell or getSnapshot. */
async function healServersFromEvidence(
  db: Db,
  candidates: Array<{ id: string; connectedAt: string | null }>,
  onConnectedFromEvidence: (
    db: Db,
    serverId: string,
    connectedAt?: string | null,
  ) => Promise<unknown>,
): Promise<void> {
  if (candidates.length === 0) return;

  sweepTrace("self-heal-direct", { count: candidates.length });

  await withBoundedConcurrency(
    candidates,
    FANOUT_CONCURRENCY,
    async (candidate) => {
      try {
        await onConnectedFromEvidence(db, candidate.id, candidate.connectedAt);
      } catch (err) {
        sweepTrace("self-heal-failed", {
          serverId: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

type SweepResolvedDeps = Required<
  Pick<
    SweepOnceDeps,
    | "registry"
    | "listConnected"
    | "listRecentlyOffline"
    | "onConnected"
    | "onConnectedFromEvidence"
    | "onDisconnected"
  >
>;

/** Fallback path: today's check-all behavior (AE unavailable / query failed). */
async function sweepOnceFallback(
  db: Db,
  deps: SweepResolvedDeps,
  nowMs: number,
): Promise<void> {
  const connected = await deps.listConnected(db);
  const recentlyOffline = await deps.listRecentlyOffline(db);
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

  const { staleIds, healIds } = await probeCandidates(
    candidates,
    deps.registry,
    nowMs,
  );

  await demoteStale(db, staleIds, deps.onDisconnected);
  pruneNullGraceBookkeeping(new Set(candidates.map((c) => c.id)));
  await healServers(db, healIds, deps.registry, deps.onConnected);
}

/** AE-active path: skip DO wakes for hosts with a recent metrics sample. */
async function sweepOnceWithAe(
  db: Db,
  activeById: Map<string, number>,
  deps: SweepResolvedDeps,
  nowMs: number,
): Promise<void> {
  const connected = await deps.listConnected(db);
  const recentlyOffline = await deps.listRecentlyOffline(db);

  const suspects = connected.filter((c) => !activeById.has(c.id));
  const suspectBatch = rotateSweepBatch(
    suspects,
    CONNECTED_SWEEP_BUDGET,
    nowMs,
  );

  // Cap all self-heal work (AE-direct + probe) by SELF_HEAL_SWEEP_BUDGET
  // before partitioning — otherwise a large AE-active recently-offline set
  // bypasses the budget. AE-direct heals are Postgres-only (no DO wake);
  // probed heals still go through healServers after checkLiveness.
  const selfHealRotated = rotateSweepBatch(
    recentlyOffline,
    SELF_HEAL_SWEEP_BUDGET,
    nowMs,
  );
  // Only direct-heal when AE evidence is strictly newer than the offline
  // transition — a pre-disconnect sample inside the AE window is not enough.
  const directHeal = selfHealRotated.filter((c) =>
    canDirectHealFromAeEvidence(c.offlineAt, activeById.get(c.id))
  );
  const directHealIds = new Set(directHeal.map((c) => c.id));
  const selfHealBatch = selfHealRotated.filter((c) => !directHealIds.has(c.id));

  sweepTrace("ae-liveness", {
    connected: connected.length,
    aeActive: activeById.size,
    suspectsProbed: suspectBatch.length,
    selfHealDirect: directHeal.length,
  });

  const probeBatch = mergeSweepCandidates(suspectBatch, selfHealBatch);
  const { staleIds, healIds } = probeBatch.length > 0
    ? await probeCandidates(probeBatch, deps.registry, nowMs)
    : { staleIds: [] as string[], healIds: [] as string[] };

  await demoteStale(db, staleIds, deps.onDisconnected);
  pruneNullGraceBookkeeping(new Set(probeBatch.map((c) => c.id)));

  // AE-direct heal stays separate from probed heals — must not call
  // registry.getCell() / getSnapshot().
  await healServersFromEvidence(
    db,
    directHeal,
    deps.onConnectedFromEvidence,
  );
  await healServers(db, healIds, deps.registry, deps.onConnected);
}

export async function sweepOnce(
  env: CloudflareBindings,
  db: Db,
  deps: SweepOnceDeps = {},
): Promise<void> {
  const nowMs = Date.now();
  const registry = deps.registry ??
    createDurableObjectDaemonCellRegistry(env, db);
  const resolveActiveServerIds = deps.resolveActiveServerIds ??
    (() => resolveRecentlyActiveServerIds(env));
  const listConnected = deps.listConnected ?? listConnectedServersForSweep;
  const listRecentlyOffline = deps.listRecentlyOffline ??
    listRecentlyOfflineServersForSweep;
  const onConnected = deps.onConnected ?? onDaemonConnected;
  const onConnectedFromEvidence = deps.onConnectedFromEvidence ??
    onDaemonConnectedFromEvidence;
  const onDisconnected = deps.onDisconnected ?? onDaemonDisconnected;

  const resolvedDeps: SweepResolvedDeps = {
    registry,
    listConnected,
    listRecentlyOffline,
    onConnected,
    onConnectedFromEvidence,
    onDisconnected,
  };

  let activeById: Map<string, number> | null;
  try {
    activeById = await resolveActiveServerIds();
  } catch (err) {
    sweepTrace("ae-resolve-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    activeById = null;
  }
  if (activeById === null) {
    await sweepOnceFallback(db, resolvedDeps, nowMs);
    return;
  }

  await sweepOnceWithAe(db, activeById, resolvedDeps, nowMs);
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
