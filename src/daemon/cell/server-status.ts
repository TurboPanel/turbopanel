/**
 * Server status read model — Postgres-backed, no Durable Object reads on the default path.
 *
 * Vocabulary:
 *   daemon cell     = live connection owner (DaemonCell / DaemonCellObject / RedisDaemonCell)
 *   server status   = DB-projected read model (this module)
 *   projection      = daemon cell writing meaningful state to Postgres (postgres-projection.ts)
 */
import { inArray } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { parseServerDaemonState } from "../authn/daemon-state.ts";
import type {
  ServerMetadata,
  ServerOsMetadata,
  ServerTimeSync,
} from "../../lib/db/server-metadata.ts";
import {
  parseServerOsMetadata,
  parseServerTimeSync,
} from "../../lib/db/server-metadata.ts";
import type { ServerAddresses } from "../../server-addresses.ts";
import { parseServerAddresses } from "../../server-addresses.ts";
import type { ServerGeo } from "../../lib/geo/server-geo.ts";
import { parseServerGeo } from "../../lib/geo/server-geo.ts";
import { server } from "../../lib/db/schema.ts";
import type { DaemonCellRegistry, DaemonCellSnapshot } from "./contracts.ts";
import { DAEMON_STALE_MS } from "./protocol.ts";
import {
  readProjectionsForServers,
  type ServerDaemonProjectionRead,
  type ServerFleetPresenceRow,
} from "./postgres-projection.ts";

export type ServerFleetPresence = {
  serverId: string;
  connected: boolean;
  hostname: string | null;
  machineId: string | null;
  remoteAddress: string | null;
  directAttach: boolean;
  keyId: string | null;
  connectedAt: string | null;
  lastInboundAt: string | null;
  lastSeenAt: string | null;
  keyLastUsedAt: string | null;
  agent?: {
    commit?: string;
    buildId?: string;
    builtAt?: string;
    channel?: string;
  };
  geo: ServerGeo | null;
  /** From `server.metadata.os` (daemon hello); null until reported. */
  os: ServerOsMetadata | null;
  /** From `server.metadata.timeSync` (hello / change-detected heartbeat). */
  timeSync: ServerTimeSync | null;
  /** From `server.metadata.addresses` (hello / change-detected heartbeat). */
  addresses: ServerAddresses | null;
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
  return Date.now() - lastInboundMs < DAEMON_STALE_MS;
}

export type PreloadedFleetPresenceData = {
  rows: ServerFleetPresenceRow[];
  projections: Map<string, ServerDaemonProjectionRead>;
};

export type ResolveFleetPresenceOptions = {
  /**
   * Read live Durable Object / Redis snapshots and prefer them over the sparse
   * Postgres projection. This costs one cell read per server, so it is reserved
   * for explicit diagnostics-only callers. Defaults to `false`, in which case
   * coarse presence and agent data are served from the Postgres projection.
   */
  withSnapshots?: boolean;
  /** Skip redundant SELECTs when the caller already loaded rows and projections. */
  preloaded?: PreloadedFleetPresenceData;
};

/**
 * Resolve fleet presence.
 *
 * By default this path is Postgres-only: coarse presence and agent data come
 * from dedicated status columns plus sparse `server.daemon.projection`. It
 * never calls `listOnlineServerIds` or `getSnapshots`. On Workers,
 * silent-failure offline correctness is disconnect-first (`webSocketClose` /
 * `webSocketError`); Redis (Deno) uses a timer-driven sweep via `maintain()`
 * at `DAEMON_OFFLINE_SWEEP_MS`. Neither path reads live cell state at request
 * time by default.
 * Pass `{ withSnapshots: true }` for explicit diagnostics/admin callers that
 * read live cell snapshots for every server up front.
 */
export async function resolveFleetPresence(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverIds: string[],
  options: ResolveFleetPresenceOptions = {},
): Promise<Map<string, ServerFleetPresence>> {
  if (serverIds.length === 0) return new Map();

  const withSnapshots = options.withSnapshots ?? false;
  const preloaded = options.preloaded;

  const [rows, projections, snapshots] = await Promise.all([
    preloaded
      ? Promise.resolve(preloaded.rows)
      : db
        .select({
          id: server.id,
          daemon: server.daemon,
          metadata: server.metadata,
          hostname: server.hostname,
          machineId: server.machineId,
          connected: server.connected,
          daemonStatus: server.daemonStatus,
          lastSeenAt: server.lastSeenAt,
          connectedAt: server.connectedAt,
          disconnectedAt: server.disconnectedAt,
          statusChangedAt: server.statusChangedAt,
        })
        .from(server)
        .where(inArray(server.id, serverIds)),
    preloaded
      ? Promise.resolve(preloaded.projections)
      : readProjectionsForServers(db, serverIds),
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
    const connected = snapshot === undefined
      ? (projection?.connected ?? row.connected ?? false)
      : isSnapshotConnected(snapshot);

    const lastInboundAt = snapshot
      ? resolveLastInboundAt(snapshot)
      : projection?.lastSeenAt ?? row.lastSeenAt ?? null;

    result.set(row.id, {
      serverId: row.id,
      connected,
      hostname: row.hostname ?? null,
      machineId: row.machineId ?? null,
      remoteAddress: normalizeRemoteAddress(rawRemote),
      directAttach: rawRemote === "__direct__",
      keyId: projection?.keyId ?? state?.key.id ?? null,
      connectedAt: snapshot?.connectedAt ?? projection?.connectedAt ??
        row.connectedAt ?? null,
      lastInboundAt,
      lastSeenAt: snapshot?.lastSeenAt ?? projection?.lastSeenAt ??
        row.lastSeenAt ?? null,
      keyLastUsedAt: snapshot?.keyLastUsedAt ?? null,
      agent: projection?.agent ?? snapshot?.agent ?? undefined,
      geo: parseServerGeo(metadata.geo),
      os: parseServerOsMetadata(metadata.os) ?? null,
      timeSync: parseServerTimeSync(metadata.timeSync) ?? null,
      addresses: parseServerAddresses(metadata.addresses) ?? null,
    });
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
    connectedAt: presence.connectedAt ?? "",
    hostname: presence.hostname,
    serverId: presence.serverId,
    keyId: presence.keyId,
    authenticated: presence.connected,
    remoteAddress: presence.remoteAddress,
    lastInboundAt: presence.lastInboundAt
      ? Date.parse(presence.lastInboundAt)
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
