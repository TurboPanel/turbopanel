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
  daemonBuildChanged,
  identityFromSnapshot,
  projectServerDaemon,
  steadyStateInboundSkipsDbRead,
  type ProjectionDaemonBuild,
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
  daemonBuild?: ProjectionDaemonBuild,
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
  }, { cell, daemonBuild });
}

/**
 * Postgres-only online projection for AE-direct offline-sweep self-heal.
 * Marks the server online without a `DaemonCell` or `getSnapshot()` — so
 * Workers never wake the Durable Object. Existing projection identity is
 * preserved (empty identity merge); pass `connectedAt` when known from the
 * prior Postgres status to keep "Connected Since" stable across false demotions.
 */
export async function onDaemonConnectedFromEvidence(
  db: Db,
  serverId: string,
  connectedAt?: string | null,
): Promise<void> {
  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: {},
    reason: "self_heal",
    ...(connectedAt ? { connectedAt } : {}),
  });
}

/**
 * Project inbound hello/heartbeat traffic. When the sparse Postgres status is
 * offline or the cell runtime flag was cleared by a stale sweep, treat inbound
 * as an online transition instead of a heartbeat-only touch.
 *
 * `opts.geo` comes from the Workers attach header (stamped on the hibernation
 * WebSocket attachment). Pass it so hello can backfill `metadata.geo` when the
 * attach `waitUntil` connect projection raced or failed.
 */
export async function onDaemonInbound(
  db: Db,
  serverId: string,
  cell: DaemonCell,
  opts: { at?: string; daemonBuild?: ProjectionDaemonBuild; geo?: ServerGeo } = {},
): Promise<void> {
  if (opts.daemonBuild?.commit && opts.daemonBuild?.buildId) {
    await maybeRepairUpdateFromDaemonBuildHello(db, serverId, opts.daemonBuild);

    const existingForDaemonBuild = await getServerDaemonStateByServerId(db, serverId);
    if (daemonBuildChanged(existingForDaemonBuild?.projection, opts.daemonBuild)) {
      await projectServerDaemon(db, serverId, {
        kind: "daemon-build",
        daemonBuild: opts.daemonBuild,
      }, { cell });
    }
  }

  const snapshot = await cell.getSnapshot();

  // Backfill / refresh geo before the steady-state short-circuit — attach geo is
  // only available on this socket and must not wait for a later reconnect.
  if (opts.geo) {
    await projectServerDaemon(db, serverId, {
      kind: "identity",
      identity: {
        ...identityFromSnapshot(snapshot),
        geo: opts.geo,
      },
    }, { cell });
  }

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
      opts.daemonBuild,
      opts.geo,
    );
    return;
  }

  await onDaemonHeartbeat(db, serverId, cell, opts.daemonBuild, opts.at);
}

export async function onDaemonDisconnected(
  db: Db,
  serverId: string,
  cell?: DaemonCell,
  reason: "disconnect" | "sweep_stale" = "disconnect",
): Promise<void> {
  await projectServerDaemon(
    db,
    serverId,
    { kind: "disconnected", reason },
    { cell },
  );
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
export async function maybeRepairUpdateFromDaemonBuildHello(
  db: Db,
  serverId: string,
  daemonBuild?: ProjectionDaemonBuild,
  targetCommit?: string,
): Promise<void> {
  if (!daemonBuild?.commit || !daemonBuild?.buildId) return;

  const existing = await getServerDaemonStateByServerId(db, serverId);
  const update = existing?.projection?.update;
  if (update?.status !== "updating") return;

  const manifestCommit = targetCommit ??
    (await resolveTrunkManifest())?.commit;
  if (!manifestCommit || daemonBuild.commit !== manifestCommit) return;

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
  daemonBuild?: ProjectionDaemonBuild,
  inboundAt?: string,
): Promise<void> {
  // Heartbeat-only frames never open Postgres without a daemonBuild that may have
  // changed — elapsed coalesce time alone is not a projection trigger.
  if (!daemonBuild?.commit || !daemonBuild?.buildId) return;

  const snapshot = await cell.getSnapshot();
  // Skip Postgres SELECT when the cell snapshot shows steady-state heartbeats.
  if (steadyStateInboundSkipsDbRead(snapshot, { at: inboundAt, daemonBuild })) {
    return;
  }

  const existing = await getServerDaemonStateByServerId(db, serverId);
  if (!existing) return;

  if (!daemonBuildChanged(existing.projection, daemonBuild)) return;

  await projectServerDaemon(db, serverId, { kind: "heartbeat", daemonBuild });
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
        await onDaemonDisconnected(db, serverId, cell, "sweep_stale");
      }
    }),
  );
}
