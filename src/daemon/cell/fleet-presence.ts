import { inArray } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { parseServerDaemonState } from "../authn/daemon-state.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import { server } from "../../lib/db/schema.ts";
import type { DaemonCellRegistry, DaemonCellSnapshot } from "./contracts.ts";
import { DAEMON_STALE_MS } from "./protocol.ts";
import { readProjectionsForServers } from "./postgres-projection.ts";

const STALE_THRESHOLD_MS = DAEMON_STALE_MS;

export type ServerFleetPresence = {
  serverId: string;
  connected: boolean;
  hostname: string | null;
  machineId: string | null;
  remoteAddress: string | null;
  directAttach: boolean;
  keyId: string | null;
  connectedAt: string | null;
  lastProjectedAt: string | null;
  /** @deprecated use {@link ServerFleetPresence.lastInboundAt} */
  lastHeartbeatAt: string | null;
  lastInboundAt: string | null;
  lastSeenAt: string | null;
  keyLastUsedAt: string | null;
  agent?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
};

function normalizeRemoteAddress(
  value: string | undefined | null,
): string | null {
  if (!value || value === "__direct__") return null;
  return value;
}

function resolveLastInboundAt(snapshot: DaemonCellSnapshot): string | null {
  return snapshot.lastInboundAt ?? snapshot.lastSeenAt ?? snapshot.connectedAt ??
    null;
}

function isSnapshotConnected(snapshot: DaemonCellSnapshot): boolean {
  if (!snapshot.connected) return false;
  const lastInbound = resolveLastInboundAt(snapshot);
  if (!lastInbound) return false;
  const lastInboundMs = Date.parse(lastInbound);
  if (Number.isNaN(lastInboundMs)) return false;
  return Date.now() - lastInboundMs < STALE_THRESHOLD_MS;
}

export type ResolveFleetPresenceOptions = {
  /**
   * Read live Durable Object / Redis snapshots and prefer them over the sparse
   * Postgres projection. This costs one cell read per server, so it is reserved
   * for explicit diagnostics-only callers. Defaults to `false`, in which case
   * coarse presence and agent data are served from the Postgres projection.
   */
  withSnapshots?: boolean;
};

/**
 * Resolve fleet presence.
 *
 * By default this serves coarse presence and agent data from the sparse
 * Postgres projection (plus the cheap online index from the cell registry —
 * Redis on Deno, projection on Workers). When the projection marks a server
 * offline, a follow-up live cell snapshot read is performed for those servers
 * only so a stale `connected: false` row cannot hide an active WebSocket.
 * Pass `{ withSnapshots: true }` to read live snapshots for every server.
 */
export async function resolveFleetPresence(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverIds: string[],
  options: ResolveFleetPresenceOptions = {},
): Promise<Map<string, ServerFleetPresence>> {
  if (serverIds.length === 0) return new Map();

  const withSnapshots = options.withSnapshots ?? false;

  const [rows, projections, onlineSet, snapshots] = await Promise.all([
    db
      .select({
        id: server.id,
        daemon: server.daemon,
        metadata: server.metadata,
      })
      .from(server)
      .where(inArray(server.id, serverIds)),
    readProjectionsForServers(db, serverIds),
    registry
      ? registry.listOnlineServerIds().then((ids) => new Set(ids))
      : Promise.resolve<Set<string> | null>(null),
    withSnapshots && registry
      ? registry.getSnapshots(serverIds)
      : Promise.resolve(new Map<string, DaemonCellSnapshot>()),
  ]);

  const result = new Map<string, ServerFleetPresence>();
  for (const row of rows) {
    const projection = projections.get(row.id);
    const metadata = (row.metadata ?? {}) as ServerMetadata;
    const state = parseServerDaemonState(row.daemon);
    const rawRemote = projection?.remoteAddress ?? null;
    const snapshot = snapshots.get(row.id);
    const connected = snapshot !== undefined
      ? isSnapshotConnected(snapshot)
      : onlineSet
      ? onlineSet.has(row.id)
      : (projection?.connected ?? state?.projection?.connected ?? false);

    const lastInboundAt = snapshot
      ? resolveLastInboundAt(snapshot)
      : projection?.lastProjectedAt ?? null;

    result.set(row.id, {
      serverId: row.id,
      connected,
      hostname: projection?.hostname ?? metadata.hostname ?? null,
      machineId: projection?.machineId ?? metadata.machineId ?? null,
      remoteAddress: normalizeRemoteAddress(rawRemote),
      directAttach: rawRemote === "__direct__",
      keyId: projection?.keyId ?? state?.key.id ?? null,
      connectedAt: snapshot?.connectedAt ?? projection?.connectedAt ?? null,
      lastProjectedAt: projection?.lastProjectedAt ?? null,
      lastInboundAt,
      lastHeartbeatAt: lastInboundAt,
      lastSeenAt: snapshot?.lastSeenAt ?? projection?.lastProjectedAt ?? null,
      keyLastUsedAt: snapshot?.keyLastUsedAt ?? null,
      agent: projection?.agent ?? snapshot?.agent ?? undefined,
    });
  }

  if (!withSnapshots && registry) {
    const staleOfflineIds = [...result.entries()]
      .filter(([, presence]) => !presence.connected)
      .map(([id]) => id);
    if (staleOfflineIds.length > 0) {
      const liveSnapshots = await registry.getSnapshots(staleOfflineIds);
      for (const id of staleOfflineIds) {
        const live = liveSnapshots.get(id);
        if (!live || !isSnapshotConnected(live)) continue;
        const entry = result.get(id);
        if (!entry) continue;
        entry.connected = true;
        entry.connectedAt = live.connectedAt ?? entry.connectedAt;
        entry.lastInboundAt = resolveLastInboundAt(live);
        entry.lastHeartbeatAt = entry.lastInboundAt;
        entry.lastSeenAt = live.lastSeenAt ?? entry.lastSeenAt;
        entry.agent = entry.agent ?? live.agent;
      }
    }
  }

  return result;
}

export async function resolveOnlineFleetPresence(
  db: Db,
  registry: DaemonCellRegistry,
): Promise<ServerFleetPresence[]> {
  const onlineIds = await registry.listOnlineServerIds();
  if (onlineIds.length === 0) return [];
  const presence = await resolveFleetPresence(db, registry, onlineIds);
  return onlineIds
    .map((id) => presence.get(id))
    .filter((row): row is ServerFleetPresence => row !== undefined);
}

export function fleetPresenceToConnection(presence: ServerFleetPresence) {
  return {
    id: presence.serverId,
    connectedAt: presence.connectedAt ?? presence.lastProjectedAt ?? "",
    hostname: presence.hostname,
    serverId: presence.serverId,
    keyId: presence.keyId,
    authenticated: presence.connected,
    remoteAddress: presence.remoteAddress,
    lastInboundAt: presence.lastInboundAt ?? presence.lastHeartbeatAt
      ? Date.parse(presence.lastInboundAt ?? presence.lastHeartbeatAt ?? "")
      : 0,
    connected: presence.connected,
  };
}

export async function isServerConnected(
  db: Db,
  registry: DaemonCellRegistry,
  serverId: string,
): Promise<boolean> {
  const presence = await resolveFleetPresence(db, registry, [serverId]);
  return presence.get(serverId)?.connected ?? false;
}
