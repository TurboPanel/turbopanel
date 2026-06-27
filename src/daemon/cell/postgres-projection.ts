import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../db.ts";
import {
  parseServerDaemonState,
  type ServerDaemonProjection,
  type ServerDaemonState,
} from "../authn/daemon-state.ts";
import { getServerDaemonStateByServerId } from "../authn/server-identity-db.ts";
import { server } from "../../lib/db/schema.ts";
import { touchServerMetadata } from "../../server-registry.ts";
import type { DaemonCell } from "./contracts.ts";
import type { DaemonCellSnapshot } from "./contracts.ts";

export type ProjectionIdentity = {
  hostname?: string;
  machineId?: string;
  remoteAddress?: string;
  keyId?: string;
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
  | { kind: "identity"; identity: ProjectionIdentity }
  | {
    kind: "agent";
    agent: {
      commit: string;
      buildId: string;
      builtAt?: string;
      channel?: string;
    };
  };

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

function attachPreservedAgent(
  projection: ServerDaemonProjection,
  current: ServerDaemonProjection | undefined,
  incoming?: ProjectionAgent,
): ServerDaemonProjection {
  const agent = mergeAgentPreserving(current, incoming);
  return agent ? { ...projection, agent } : projection;
}

async function writeMergedDaemonState(
  db: Db,
  serverId: string,
  merged: ServerDaemonState,
): Promise<void> {
  const now = nowTs();
  await db.update(server).set({
    daemon: merged,
    updatedAt: now,
  }).where(eq(server.id, serverId));
}

/**
 * Sparse projection into `server.daemon.projection` — never clobbers `server.daemon.key`.
 * `lastSeenAt` is written to the daemon cell snapshot on online/offline liveness transitions.
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
  const now = nowTs();
  let nextProjection: ServerDaemonProjection | null = null;
  let touchLastSeen = false;
  let touchMetadata = false;

  switch (trigger.kind) {
    case "online": {
      touchLastSeen = true;
      const identity = mergeIdentity(currentProjection, trigger.identity);
      touchMetadata = identityChanged(currentProjection, identity);
      nextProjection = {
        ...identity,
        connected: true,
        connectedAt: trigger.connectedAt ?? currentProjection?.connectedAt ??
          now,
        lastProjectedAt: now,
      };
      break;
    }
    case "offline": {
      touchLastSeen = true;
      nextProjection = {
        hostname: currentProjection?.hostname,
        machineId: currentProjection?.machineId,
        remoteAddress: currentProjection?.remoteAddress,
        keyId: currentProjection?.keyId,
        connected: false,
        connectedAt: currentProjection?.connectedAt,
        lastProjectedAt: now,
      };
      break;
    }
    case "disconnected": {
      touchLastSeen = true;
      nextProjection = {
        hostname: currentProjection?.hostname,
        machineId: currentProjection?.machineId,
        remoteAddress: currentProjection?.remoteAddress,
        keyId: currentProjection?.keyId,
        connected: false,
        connectedAt: currentProjection?.connectedAt,
        lastProjectedAt: now,
      };
      break;
    }
    case "identity": {
      if (!identityChanged(currentProjection, trigger.identity)) {
        return false;
      }
      touchMetadata = true;
      const identity = mergeIdentity(currentProjection, trigger.identity);
      nextProjection = {
        hostname: identity.hostname,
        machineId: identity.machineId,
        remoteAddress: identity.remoteAddress,
        keyId: identity.keyId,
        connected: currentProjection?.connected ?? false,
        connectedAt: currentProjection?.connectedAt,
        lastProjectedAt: now,
      };
      break;
    }
    case "agent": {
      if (!agentChanged(currentProjection, trigger.agent)) {
        return false;
      }
      touchLastSeen = false;
      const mergedAgent = mergeAgentPreserving(
        currentProjection,
        trigger.agent,
      );
      nextProjection = {
        ...(currentProjection ?? {
          connected: false,
          lastProjectedAt: now,
        }),
        agent: mergedAgent,
        lastProjectedAt: now,
      };
      break;
    }
  }

  if (!nextProjection) return false;

  if (trigger.kind !== "agent") {
    nextProjection = attachPreservedAgent(
      nextProjection,
      currentProjection,
      context.agent,
    );
  }

  await writeMergedDaemonState(db, serverId, {
    key: existing.key,
    projection: nextProjection,
  });

  if (touchLastSeen && context.cell) {
    void context.cell.putSnapshot({ lastSeenAt: now }).catch(() => {});
  }

  if (touchMetadata) {
    await touchServerMetadata(db, serverId, {
      hostname: nextProjection.hostname,
      machineId: nextProjection.machineId,
    });
  }

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

/** @deprecated use {@link projectServerDaemon} with explicit triggers */
export async function touchServerMetadataFromSnapshot(
  db: Db,
  serverId: string,
  snapshot: DaemonCellSnapshot,
): Promise<void> {
  const trigger: ProjectionTrigger = snapshot.connected
    ? {
      kind: "online",
      identity: identityFromSnapshot(snapshot),
      connectedAt: snapshot.connectedAt,
    }
    : { kind: "offline" };
  await projectServerDaemon(db, serverId, trigger, { cell: undefined });
  if (
    identityFromSnapshot(snapshot).hostname ||
    identityFromSnapshot(snapshot).machineId
  ) {
    await projectServerDaemon(db, serverId, {
      kind: "identity",
      identity: identityFromSnapshot(snapshot),
    });
  }
}

export async function listConnectedServerIdsFromProjection(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server);

  const online: string[] = [];
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    if (state?.projection?.connected === true) {
      online.push(row.id);
    }
  }
  return online;
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

export async function readProjectionsForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, ServerDaemonProjection>> {
  if (serverIds.length === 0) return new Map();

  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(inArray(server.id, serverIds));

  const result = new Map<string, ServerDaemonProjection>();
  for (const row of rows) {
    const state = parseServerDaemonState(row.daemon);
    if (state?.projection) {
      result.set(row.id, state.projection);
    }
  }
  return result;
}
