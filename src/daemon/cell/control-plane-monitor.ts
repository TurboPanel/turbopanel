/**
 * Control-plane projection monitor — bridges daemon cell lifecycle events to the
 * Postgres projection layer. Called from deno-ws.ts (Deno) and do.ts (Workers).
 *
 * Vocabulary:
 *   daemon cell  = live connection owner
 *   projection   = writing meaningful state to Postgres (postgres-projection.ts)
 */
import type { Db } from "../../db.ts";
import { getServerDaemonStateByServerId } from "../authn/server-identity-db.ts";
import type { DaemonCell } from "./contracts.ts";
import {
  agentChanged,
  identityFromSnapshot,
  projectServerDaemon,
  type ProjectionAgent,
} from "./postgres-projection.ts";
import { RedisDaemonCell } from "./redis/cell.ts";
import type { RedisDaemonCellRegistry } from "./redis/registry.ts";

const HEARTBEAT_DEBOUNCE_MS = 60_000;

function heartbeatDebounceElapsed(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return true;
  const lastSeenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(lastSeenMs)) return true;
  return Date.now() - lastSeenMs >= HEARTBEAT_DEBOUNCE_MS;
}

export async function onDaemonConnected(
  db: Db,
  serverId: string,
  cell: DaemonCell,
  connectedAt?: string,
  agent?: ProjectionAgent,
): Promise<void> {
  const snapshot = await cell.getSnapshot();
  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: identityFromSnapshot(snapshot),
    connectedAt: connectedAt ?? snapshot.connectedAt,
  }, { cell, agent });
}

/**
 * Project inbound hello/heartbeat traffic. When the sparse Postgres status is
 * offline or the cell runtime flag was cleared by a stale sweep, treat inbound
 * as an online transition instead of a heartbeat-only touch.
 */
export async function onDaemonInbound(
  db: Db,
  serverId: string,
  cell: DaemonCell,
  opts: { at?: string; agent?: ProjectionAgent } = {},
): Promise<void> {
  const existing = await getServerDaemonStateByServerId(db, serverId);
  const snapshot = await cell.getSnapshot();
  const projectedOffline = existing?.status?.connected === false;
  const runtimeOffline = !snapshot.connected;

  if (projectedOffline || runtimeOffline) {
    const at = opts.at ?? new Date().toISOString();
    await onDaemonConnected(
      db,
      serverId,
      cell,
      snapshot.connectedAt ?? at,
      opts.agent,
    );
    return;
  }

  await onDaemonHeartbeat(db, serverId, cell, opts.agent);
}

export async function onDaemonDisconnected(
  db: Db,
  serverId: string,
  cell?: DaemonCell,
): Promise<void> {
  await projectServerDaemon(db, serverId, { kind: "disconnected" }, { cell });
}

export async function onDaemonUpdateQueued(
  db: Db,
  serverId: string,
  requestId: string,
  channel: string,
  queuedAt: string,
): Promise<void> {
  await projectServerDaemon(db, serverId, {
    kind: "update-queued",
    requestId,
    channel,
    queuedAt,
  });
}

export async function onDaemonUpdateResult(
  db: Db,
  serverId: string,
  requestId: string,
  ok: boolean,
  finishedAt: string,
  error?: string,
): Promise<void> {
  await projectServerDaemon(db, serverId, {
    kind: "update-result",
    requestId,
    ok,
    finishedAt,
    error,
  });
}

export async function onDaemonUpdateReset(
  db: Db,
  serverId: string,
): Promise<void> {
  await projectServerDaemon(db, serverId, { kind: "update-reset" });
}

export async function onDaemonUpdateExpired(
  db: Db,
  serverId: string,
  requestId: string,
  finishedAt: string,
  error?: string,
): Promise<void> {
  await projectServerDaemon(db, serverId, {
    kind: "update-expired",
    requestId,
    finishedAt,
    error,
  });
}

export async function onDaemonHeartbeat(
  db: Db,
  serverId: string,
  _cell: DaemonCell,
  agent?: ProjectionAgent,
): Promise<void> {
  const existing = await getServerDaemonStateByServerId(db, serverId);
  if (!existing) return;

  const lastSeenDue = heartbeatDebounceElapsed(existing.status?.lastSeenAt ?? null);
  const agentDue = agent?.commit && agent?.buildId &&
    agentChanged(existing.projection, agent);

  if (!lastSeenDue && !agentDue) return;

  await projectServerDaemon(db, serverId, { kind: "heartbeat", agent });
}

export async function sweepStalePresence(
  db: Db,
  registry: RedisDaemonCellRegistry,
): Promise<void> {
  const onlineServerIds = await registry.listOnlineServerIds();
  await Promise.all(
    onlineServerIds.map(async (serverId) => {
      const cell = registry.getCell(serverId) as RedisDaemonCell;
      const demoted = await cell.reconcileStalePresence();
      if (demoted) {
        await onDaemonDisconnected(db, serverId, cell);
      }
    }),
  );
}
