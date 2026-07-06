/**
 * Control-plane projection monitor — bridges daemon cell lifecycle events to the
 * Postgres projection layer. Called from deno-ws.ts (Deno) and do.ts (Workers).
 *
 * Vocabulary:
 *   daemon cell  = live connection owner
 *   projection   = writing meaningful state to Postgres (postgres-projection.ts)
 */
import type { Db } from "../../db.ts";
import type { ServerGeo } from "../../lib/geo/server-geo.ts";
import { getServerDaemonStateByServerId } from "../authn/server-identity-db.ts";
import type { UpdateProjection } from "../authn/daemon-state.ts";
import type { DaemonCell } from "./contracts.ts";
import {
  agentChanged,
  heartbeatDebounceElapsed,
  identityFromSnapshot,
  projectServerDaemon,
  steadyStateInboundSkipsDbRead,
  type ProjectionAgent,
} from "./postgres-projection.ts";
import { resolveTrunkManifest } from "../../lib/update/manifest.ts";
import { isStaleProjectedUpdating } from "../../client/servers/update-status.ts";
import { UPDATE_REQUEST_TTL_MS } from "../../lib/update/constants.ts";
import { RedisDaemonCell } from "./redis/cell.ts";
import type { RedisDaemonCellRegistry } from "./redis/registry.ts";

export async function onDaemonConnected(
  db: Db,
  serverId: string,
  cell: DaemonCell,
  connectedAt?: string,
  agent?: ProjectionAgent,
  geo?: ServerGeo,
  keyId?: string,
): Promise<void> {
  const snapshot = await cell.getSnapshot();
  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: {
      ...identityFromSnapshot(snapshot),
      ...(keyId ? { keyId } : {}),
      ...(geo ? { geo } : {}),
    },
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
  if (opts.agent?.commit && opts.agent?.buildId) {
    await maybeRepairUpdateFromAgentHello(db, serverId, opts.agent);

    const existingForAgent = await getServerDaemonStateByServerId(db, serverId);
    if (agentChanged(existingForAgent?.projection, opts.agent)) {
      await projectServerDaemon(db, serverId, {
        kind: "agent",
        agent: opts.agent,
      }, { cell });
    }
  }

  const snapshot = await cell.getSnapshot();

  // Skip heartbeat-only Postgres reads when steady-state; repair above still runs.
  if (steadyStateInboundSkipsDbRead(snapshot, opts)) {
    return;
  }

  const existing = await getServerDaemonStateByServerId(db, serverId);
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

  await onDaemonHeartbeat(db, serverId, cell, opts.agent, opts.at);
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

/** Repair a stale `updating` Postgres projection when terminal evidence is available. */
export async function repairStaleProjectedUpdate(
  db: Db,
  serverId: string,
  projectedUpdate: UpdateProjection,
  opts: {
    currentCommit?: string | null;
    targetCommit?: string | null;
    updateTtlMs?: number;
  } = {},
): Promise<boolean> {
  if (
    !isStaleProjectedUpdating({
      projectedUpdate,
      currentCommit: opts.currentCommit,
      targetCommit: opts.targetCommit,
      updateTtlMs: opts.updateTtlMs ?? UPDATE_REQUEST_TTL_MS,
    })
  ) {
    return false;
  }

  const finishedAt = new Date().toISOString();
  const requestId = projectedUpdate.requestId ?? "";

  if (
    opts.targetCommit &&
    opts.currentCommit &&
    opts.currentCommit === opts.targetCommit
  ) {
    await projectServerDaemon(db, serverId, {
      kind: "update-result",
      requestId,
      ok: true,
      finishedAt,
    });
    return true;
  }

  await projectServerDaemon(db, serverId, {
    kind: "update-expired",
    requestId,
    finishedAt,
  });
  return true;
}

/** Self-heal when a reconnecting daemon already reports the trunk target commit. */
export async function maybeRepairUpdateFromAgentHello(
  db: Db,
  serverId: string,
  agent?: ProjectionAgent,
  targetCommit?: string,
): Promise<void> {
  if (!agent?.commit || !agent?.buildId) return;

  const existing = await getServerDaemonStateByServerId(db, serverId);
  const update = existing?.projection?.update;
  if (update?.status !== "updating") return;

  const manifestCommit = targetCommit ??
    (await resolveTrunkManifest())?.commit;
  if (!manifestCommit || agent.commit !== manifestCommit) return;

  await projectServerDaemon(db, serverId, {
    kind: "update-result",
    requestId: update.requestId ?? "",
    ok: true,
    finishedAt: new Date().toISOString(),
  });
}

export async function onDaemonHeartbeat(
  db: Db,
  serverId: string,
  cell: DaemonCell,
  agent?: ProjectionAgent,
  inboundAt?: string,
): Promise<void> {
  const snapshot = await cell.getSnapshot();
  // Skip Postgres SELECT when the cell snapshot shows steady-state heartbeats.
  if (steadyStateInboundSkipsDbRead(snapshot, { at: inboundAt, agent })) {
    return;
  }

  const existing = await getServerDaemonStateByServerId(db, serverId);
  if (!existing) return;

  const lastSeenDue = inboundAt
    ? heartbeatDebounceElapsed(
      existing.status?.lastSeenAt ?? null,
      Date.parse(inboundAt),
    )
    : heartbeatDebounceElapsed(existing.status?.lastSeenAt ?? null);
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
