/**
 * Projection layer — the daemon cell writes meaningful state changes to Postgres here.
 *
 * Vocabulary:
 *   projection  = daemon cell → Postgres write (this module)
 *   server status read model = fleet-presence.ts / server-status.ts
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import {
  buildDefaultDaemonStatus,
  parseServerDaemonState,
  type ServerDaemonProjection,
  type ServerDaemonState,
  type ServerDaemonStatus,
  type UpdateProjection,
} from "../authn/daemon-state.ts";
import { getServerDaemonStateByServerId } from "../authn/server-identity-db.ts";
import { server } from "../../lib/db/schema.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import type { ServerGeo } from "../../lib/geo/server-geo.ts";
import { mergeServerMetadataIdentity } from "../../server-registry.ts";
import type { DaemonCell } from "./contracts.ts";
import type { DaemonCellSnapshot } from "./contracts.ts";

export type ProjectionIdentity = {
  hostname?: string;
  machineId?: string;
  remoteAddress?: string;
  keyId?: string;
  geo?: ServerGeo;
};

export type ProjectionAgent = {
  commit: string;
  buildId: string;
  builtAt?: string;
  channel?: string;
};

export type ProjectionTrigger =
  | { kind: "online"; identity: ProjectionIdentity; connectedAt?: string }
  | { kind: "offline" }
  | { kind: "disconnected" }
  | { kind: "heartbeat"; agent?: ProjectionAgent }
  | { kind: "identity"; identity: ProjectionIdentity }
  | {
    kind: "agent";
    agent: {
      commit: string;
      buildId: string;
      builtAt?: string;
      channel?: string;
    };
  }
  | {
    kind: "update-queued";
    requestId: string;
    channel: string;
    queuedAt: string;
  }
  | {
    kind: "update-result";
    requestId: string;
    ok: boolean;
    finishedAt: string;
    error?: string;
  }
  | {
    kind: "update-expired";
    requestId: string;
    finishedAt: string;
    error?: string;
  }
  | { kind: "update-reset" };

/** Status-backed read model for fleet presence — excludes hostname/machineId (metadata). */
export type ServerDaemonProjectionRead = Omit<
  ServerDaemonProjection,
  "hostname" | "machineId"
> & {
  update?: UpdateProjection;
  connected: boolean;
  connectedAt?: string | null;
  lastProjectedAt?: string | null;
  daemonConnected: boolean;
  daemonConnectedAt?: string | null;
  lastSeenAt?: string | null;
};

const HEARTBEAT_DEBOUNCE_MS = 60_000;

function nowTs(): string {
  return new Date().toISOString();
}

function identityChanged(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): boolean {
  return (identity.hostname !== undefined &&
    identity.hostname !== current?.hostname) ||
    (identity.machineId !== undefined &&
      identity.machineId !== current?.machineId) ||
    (identity.remoteAddress !== undefined &&
      identity.remoteAddress !== current?.remoteAddress) ||
    (identity.keyId !== undefined && identity.keyId !== current?.keyId);
}

function mergeIdentity(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): ProjectionIdentity {
  return {
    hostname: identity.hostname ?? current?.hostname,
    machineId: identity.machineId ?? current?.machineId,
    remoteAddress: identity.remoteAddress ?? current?.remoteAddress,
    keyId: identity.keyId ?? current?.keyId,
  };
}

export function agentChanged(
  current: ServerDaemonProjection | undefined,
  agent: ProjectionAgent,
): boolean {
  const existing = current?.agent;
  if (existing?.commit !== agent.commit || existing?.buildId !== agent.buildId) {
    return true;
  }
  if (agent.builtAt !== undefined && agent.builtAt !== existing?.builtAt) {
    return true;
  }
  if (agent.channel !== undefined && agent.channel !== existing?.channel) {
    return true;
  }
  return false;
}

/** Retain the persisted build identity unless an incoming agent payload replaces it. */
export function mergeAgentPreserving(
  current: ServerDaemonProjection | undefined,
  incoming?: ProjectionAgent,
): ServerDaemonProjection["agent"] | undefined {
  if (!incoming) return current?.agent;
  const existing = current?.agent;
  if (
    existing &&
    existing.commit === incoming.commit &&
    existing.buildId === incoming.buildId
  ) {
    return {
      commit: incoming.commit,
      buildId: incoming.buildId,
      builtAt: incoming.builtAt ?? existing.builtAt,
      channel: incoming.channel ?? existing.channel,
    };
  }
  return incoming;
}

function remoteAddressChanged(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): boolean {
  const merged = mergeIdentity(current, identity);
  const incomingRemote = merged.remoteAddress?.trim();
  if (!incomingRemote) return false;

  const currentRemote = current?.remoteAddress?.trim();
  if (!currentRemote) return true;

  return incomingRemote !== currentRemote;
}

/** Geo is refreshed only when the connecting IP changes — not on every reconnect. */
function geoRefreshDue(
  currentProjection: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): boolean {
  return identity.geo !== undefined &&
    remoteAddressChanged(currentProjection, identity);
}

function buildMetadataPatch(
  existingMetadata: ServerMetadata | null | undefined,
  projection: ServerDaemonProjection | undefined,
  incomingGeo?: ServerGeo,
): ServerMetadata | null {
  const identityMerged = mergeServerMetadataIdentity(existingMetadata, {
    hostname: projection?.hostname,
    machineId: projection?.machineId,
  });
  const geoDue = incomingGeo !== undefined;
  if (!identityMerged && !geoDue) return null;
  const base = identityMerged ?? { ...(existingMetadata ?? {}) };
  if (geoDue && incomingGeo) {
    return { ...base, geo: incomingGeo };
  }
  return identityMerged;
}

function buildIdentityProjection(
  current: ServerDaemonProjection | undefined,
  identity: ProjectionIdentity,
): ServerDaemonProjection {
  return {
    hostname: identity.hostname,
    machineId: identity.machineId,
    remoteAddress: identity.remoteAddress,
    keyId: identity.keyId,
    ...(current?.agent ? { agent: current.agent } : {}),
    ...(current?.update ? { update: current.update } : {}),
  };
}

function heartbeatDebounceElapsed(lastSeenAt: string | null, nowMs: number): boolean {
  if (!lastSeenAt) return true;
  const lastSeenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(lastSeenMs)) return true;
  return nowMs - lastSeenMs >= HEARTBEAT_DEBOUNCE_MS;
}

function buildMergedDaemonState(
  existing: ServerDaemonState,
  nextProjection: ServerDaemonProjection | undefined,
  nextStatus: ServerDaemonStatus,
): ServerDaemonState {
  return {
    key: existing.key,
    ...(nextProjection ? { projection: nextProjection } : {}),
    status: nextStatus,
  };
}

/**
 * Sparse projection into `server.daemon` — never clobbers `server.daemon.key`.
 * Liveness timestamps and connection status live in `server.daemon.status` jsonb.
 */
export async function projectServerDaemon(
  db: Db,
  serverId: string,
  trigger: ProjectionTrigger,
  context: {
    cell?: DaemonCell;
    agent?: ProjectionAgent;
  } = {},
): Promise<boolean> {
  const existing = await getServerDaemonStateByServerId(db, serverId);
  if (!existing) return false;

  const currentProjection = existing.projection;
  const existingStatus = existing.status ?? buildDefaultDaemonStatus();
  const now = nowTs();
  const nowMs = Date.parse(now);
  const patch: Record<string, unknown> = { updatedAt: now };
  let touchMetadata = false;
  let nextProjection: ServerDaemonProjection | undefined = currentProjection;
  let writeProjection = false;
  let nextStatus: ServerDaemonStatus = { ...existingStatus };
  let writeStatus = false;
  let incomingGeo: ServerGeo | undefined;
  let geoDue = false;

  switch (trigger.kind) {
    case "online": {
      const identity = mergeIdentity(currentProjection, trigger.identity);
      const isOfflineToOnline = !existingStatus.connected;
      const lastSeenDue = isOfflineToOnline ||
        heartbeatDebounceElapsed(existingStatus.lastSeenAt, nowMs);
      incomingGeo = trigger.identity.geo;
      geoDue = geoRefreshDue(currentProjection, trigger.identity);
      const identityDue = identityChanged(currentProjection, identity);
      touchMetadata = identityDue || geoDue;
      if (identityDue || !currentProjection) {
        nextProjection = buildIdentityProjection(currentProjection, identity);
        if (context.agent) {
          nextProjection = {
            ...nextProjection,
            agent: mergeAgentPreserving(currentProjection, context.agent),
          };
        }
        writeProjection = true;
      } else if (context.agent && agentChanged(currentProjection, context.agent)) {
        nextProjection = {
          ...currentProjection,
          agent: mergeAgentPreserving(currentProjection, context.agent),
        };
        writeProjection = true;
      }

      if (!isOfflineToOnline && !lastSeenDue && !writeProjection && !geoDue) {
        return false;
      }

      if (isOfflineToOnline) {
        nextStatus = {
          ...nextStatus,
          connected: true,
          daemonStatus: "online",
          connectedAt: trigger.connectedAt ?? now,
          statusChangedAt: now,
        };
        writeStatus = true;
      }

      if (lastSeenDue) {
        nextStatus = { ...nextStatus, lastSeenAt: now };
        writeStatus = true;
      }
      break;
    }
    case "offline":
    case "disconnected": {
      nextStatus = {
        ...nextStatus,
        connected: false,
        daemonStatus: "offline",
        disconnectedAt: now,
        statusChangedAt: now,
      };
      writeStatus = true;
      break;
    }
    case "heartbeat": {
      const agent = trigger.agent ?? context.agent;
      const lastSeenDue = heartbeatDebounceElapsed(existingStatus.lastSeenAt, nowMs);
      const agentDue = agent?.commit && agent?.buildId &&
        agentChanged(currentProjection, agent);

      if (!lastSeenDue && !agentDue) {
        return false;
      }

      if (lastSeenDue) {
        nextStatus = { ...nextStatus, lastSeenAt: now };
        writeStatus = true;
      }

      if (agentDue && agent) {
        nextProjection = {
          ...(currentProjection ?? {}),
          agent: mergeAgentPreserving(currentProjection, agent),
        };
        writeProjection = true;
      }
      break;
    }
    case "identity": {
      incomingGeo = trigger.identity.geo;
      geoDue = geoRefreshDue(currentProjection, trigger.identity);
      const identityDue = identityChanged(currentProjection, trigger.identity);
      if (!identityDue && !geoDue) {
        return false;
      }
      touchMetadata = true;
      if (identityDue) {
        const identity = mergeIdentity(currentProjection, trigger.identity);
        nextProjection = buildIdentityProjection(currentProjection, identity);
        writeProjection = true;
      }
      break;
    }
    case "agent": {
      if (!agentChanged(currentProjection, trigger.agent)) {
        return false;
      }
      nextProjection = {
        ...(currentProjection ?? {}),
        agent: mergeAgentPreserving(currentProjection, trigger.agent),
      };
      writeProjection = true;
      break;
    }
    case "update-queued": {
      nextProjection = {
        ...(currentProjection ?? {}),
        update: {
          status: "updating",
          requestId: trigger.requestId,
          channel: trigger.channel,
          queuedAt: trigger.queuedAt,
        },
      };
      writeProjection = true;
      break;
    }
    case "update-result": {
      nextProjection = {
        ...(currentProjection ?? {}),
        update: {
          status: trigger.ok ? "done" : "failed",
          requestId: trigger.requestId,
          finishedAt: trigger.finishedAt,
          ...(trigger.error ? { error: trigger.error } : {}),
        },
      };
      writeProjection = true;
      break;
    }
    case "update-expired": {
      const currentUpdate = currentProjection?.update;
      if (currentUpdate?.status !== "updating") {
        return false;
      }
      if (
        currentUpdate.requestId &&
        trigger.requestId &&
        currentUpdate.requestId !== trigger.requestId
      ) {
        return false;
      }
      nextProjection = {
        ...(currentProjection ?? {}),
        update: {
          status: "expired",
          requestId: trigger.requestId ?? currentUpdate.requestId,
          channel: currentUpdate.channel,
          queuedAt: currentUpdate.queuedAt,
          finishedAt: trigger.finishedAt,
          error: trigger.error ??
            "Update timed out waiting for daemon acknowledgement",
        },
      };
      writeProjection = true;
      break;
    }
    case "update-reset": {
      nextProjection = {
        ...(currentProjection ?? {}),
        update: { status: "idle" },
      };
      writeProjection = true;
      break;
    }
  }

  if (!writeStatus && !writeProjection && !geoDue) {
    return false;
  }

  patch.daemon = buildMergedDaemonState(existing, nextProjection, nextStatus);

  if (touchMetadata) {
    const mergedMetadata = buildMetadataPatch(
      existing.metadata,
      nextProjection,
      geoDue ? incomingGeo : undefined,
    );
    if (mergedMetadata) {
      patch.metadata = mergedMetadata;
    }
  }

  await db.update(server).set(patch).where(eq(server.id, serverId));

  return true;
}

export function identityFromSnapshot(
  snapshot: DaemonCellSnapshot,
): ProjectionIdentity {
  return {
    hostname: snapshot.hostname,
    machineId: snapshot.machineId,
    remoteAddress: snapshot.remoteAddress,
    keyId: snapshot.keyId,
  };
}

export async function listConnectedServerIdsFromProjection(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(sql`(
      ${server.daemon}->'status'->>'connected' = 'true'
      OR ${server.daemon}->'projection'->>'connected' = 'true'
    )`);

  const connected: string[] = [];
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    if (state?.status?.connected) {
      connected.push(row.id);
    }
  }
  return connected;
}

/** All servers with an enrolled daemon key — used to scope Workers maintenance drains. */
export async function listEnrolledDaemonServerIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server);

  const enrolled: string[] = [];
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    if (state?.key) {
      enrolled.push(row.id);
    }
  }
  return enrolled;
}

function toProjectionRead(row: {
  id: string;
  daemon: unknown;
}): ServerDaemonProjectionRead | null {
  const state = parseServerDaemonState(row.daemon);
  const status = state?.status ?? buildDefaultDaemonStatus();
  if (!state?.projection && !status.connected && !status.lastSeenAt) {
    return null;
  }

  const projection = state?.projection ?? {};
  const {
    hostname: _hostname,
    machineId: _machineId,
    ...presenceProjection
  } = projection;
  return {
    ...presenceProjection,
    connected: status.connected,
    connectedAt: status.connectedAt,
    lastProjectedAt: status.lastSeenAt,
    daemonConnected: status.connected,
    daemonConnectedAt: status.connectedAt,
    lastSeenAt: status.lastSeenAt,
  };
}

export async function readProjectionsForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, ServerDaemonProjectionRead>> {
  if (serverIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: server.id,
      daemon: server.daemon,
    })
    .from(server)
    .where(inArray(server.id, serverIds));

  const result = new Map<string, ServerDaemonProjectionRead>();
  for (const row of rows) {
    const read = toProjectionRead(row);
    if (read) {
      result.set(row.id, read);
    }
  }
  return result;
}

export async function listServerIdsWithUpdatingProjection(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(
      sql`${server.daemon}->'projection'->'update'->>'status' = 'updating'`,
    );

  return rows.map((row) => row.id);
}
