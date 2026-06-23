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
import type { DaemonCell, MonitorResourceRow } from "./contracts.ts";
import type { DaemonCellSnapshot } from "./contracts.ts";
import {
  computeEffectiveStatus,
  type MonitorEvent,
  type MonitorResourceKind,
  type MonitorResourceStatus,
} from "./monitor-contracts.ts";
import { incrementMonitorCounter } from "./monitor-observability.ts";

/** cap for slow summary refresh without a triggering transition. */
export const PROJECTION_SUMMARY_REFRESH_MS = 15 * 60 * 1000;

export type ProjectionIdentity = {
  hostname?: string;
  machineId?: string;
  remoteAddress?: string;
  keyId?: string;
};

export type ProjectionTrigger =
  | { kind: "online"; identity: ProjectionIdentity; connectedAt?: string }
  | { kind: "offline" }
  | { kind: "identity"; identity: ProjectionIdentity }
  | { kind: "resource_transition"; events: MonitorEvent[] }
  | { kind: "summary_refresh" };

const UX_RESOURCE_KINDS = new Set<MonitorResourceKind>([
  "instance",
  "project",
  "service",
  "container",
]);

const UX_STATUSES = new Set<MonitorResourceStatus>([
  "healthy",
  "degraded",
  "unhealthy",
  "failed",
  "offline",
]);

function nowTs(): string {
  return new Date().toISOString();
}

export function isMeaningfulMonitorTransition(event: MonitorEvent): boolean {
  if (!event.resourceKey) {
    return event.toStatus === "offline";
  }
  if (event.kind && !UX_RESOURCE_KINDS.has(event.kind)) {
    return false;
  }
  return UX_STATUSES.has(event.toStatus) ||
    (event.fromStatus != null && UX_STATUSES.has(event.fromStatus));
}

export function summarizeMonitorResources(
  resources: MonitorResourceRow[],
  instanceAt: string,
): Pick<
  ServerDaemonProjection,
  "status" | "healthyCount" | "degradedCount" | "unhealthyCount"
> {
  let healthyCount = 0;
  let degradedCount = 0;
  let unhealthyCount = 0;

  for (const resource of resources) {
    const effective = computeEffectiveStatus(resource.status, instanceAt);
    if (effective === "healthy" || effective === "starting") {
      healthyCount += 1;
    } else if (effective === "degraded") {
      degradedCount += 1;
    } else if (effective === "unhealthy" || effective === "failed") {
      unhealthyCount += 1;
    }
  }

  let status: MonitorResourceStatus = "healthy";
  if (unhealthyCount > 0) {
    status = "unhealthy";
  } else if (degradedCount > 0) {
    status = "degraded";
  } else if (resources.length === 0) {
    status = "unknown";
  }

  return { status, healthyCount, degradedCount, unhealthyCount };
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

function summaryNeedsRefresh(lastProjectedAt: string | undefined): boolean {
  if (!lastProjectedAt) return true;
  const parsed = Date.parse(lastProjectedAt);
  if (Number.isNaN(parsed)) return true;
  return Date.now() - parsed >= PROJECTION_SUMMARY_REFRESH_MS;
}

async function writeMergedDaemonState(
  db: Db,
  serverId: string,
  merged: ServerDaemonState,
  touchLastSeen: boolean,
): Promise<void> {
  const now = nowTs();
  const patch: Record<string, unknown> = {
    daemon: merged,
    updatedAt: now,
  };
  if (touchLastSeen) {
    patch.lastSeenAt = now;
  }
  await db.update(server).set(patch).where(eq(server.id, serverId));
  incrementMonitorCounter("postgresProjectionsWritten");
}

/**
 * Sparse projection into `server.daemon.projection` — never clobbers `server.daemon.key`.
 * Also updates `server.lastSeenAt` only on online/offline liveness transitions.
 */
export async function projectServerDaemon(
  db: Db,
  serverId: string,
  trigger: ProjectionTrigger,
  context: {
    cell?: DaemonCell;
    resources?: MonitorResourceRow[];
    instanceAt?: string;
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
      let summary = currentProjection
        ? {
          status: currentProjection.status,
          healthyCount: currentProjection.healthyCount,
          degradedCount: currentProjection.degradedCount,
          unhealthyCount: currentProjection.unhealthyCount,
        }
        : summarizeMonitorResources([], now);

      if (context.cell) {
        const [resources, instance] = await Promise.all([
          context.resources ?? context.cell.listMonitorResources(serverId),
          context.cell.getMonitorInstance(serverId),
        ]);
        summary = summarizeMonitorResources(
          resources,
          instance?.at ?? context.instanceAt ?? now,
        );
      }

      nextProjection = {
        ...identity,
        connected: true,
        connectedAt: trigger.connectedAt ?? currentProjection?.connectedAt ??
          now,
        lastProjectedAt: now,
        ...summary,
      };
      break;
    }
    case "offline": {
      touchLastSeen = true;
      incrementMonitorCounter("offlineTransitions");
      nextProjection = {
        hostname: currentProjection?.hostname,
        machineId: currentProjection?.machineId,
        remoteAddress: currentProjection?.remoteAddress,
        keyId: currentProjection?.keyId,
        connected: false,
        connectedAt: currentProjection?.connectedAt,
        status: "offline",
        healthyCount: currentProjection?.healthyCount ?? 0,
        degradedCount: currentProjection?.degradedCount ?? 0,
        unhealthyCount: currentProjection?.unhealthyCount ?? 0,
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
        status: currentProjection?.status ?? "unknown",
        healthyCount: currentProjection?.healthyCount ?? 0,
        degradedCount: currentProjection?.degradedCount ?? 0,
        unhealthyCount: currentProjection?.unhealthyCount ?? 0,
        lastProjectedAt: now,
      };
      break;
    }
    case "resource_transition": {
      const meaningful = trigger.events.filter(isMeaningfulMonitorTransition);
      if (meaningful.length === 0) return false;
      incrementMonitorCounter("resourceTransitions", meaningful.length);

      if (!context.cell && !context.resources) return false;

      const [resources, instance] = await Promise.all([
        context.resources ?? context.cell!.listMonitorResources(serverId),
        context.cell?.getMonitorInstance(serverId) ?? Promise.resolve(null),
      ]);
      const summary = summarizeMonitorResources(
        resources,
        instance?.at ?? context.instanceAt ?? now,
      );
      const identity = mergeIdentity(currentProjection, {
        hostname: currentProjection?.hostname,
        machineId: currentProjection?.machineId,
        remoteAddress: currentProjection?.remoteAddress,
        keyId: currentProjection?.keyId,
      });

      nextProjection = {
        ...identity,
        connected: currentProjection?.connected ?? false,
        connectedAt: currentProjection?.connectedAt,
        lastProjectedAt: now,
        ...summary,
      };
      break;
    }
    case "summary_refresh": {
      if (!summaryNeedsRefresh(currentProjection?.lastProjectedAt)) {
        return false;
      }
      if (!context.cell && !context.resources) return false;

      const [resources, instance] = await Promise.all([
        context.resources ?? context.cell!.listMonitorResources(serverId),
        context.cell?.getMonitorInstance(serverId) ?? Promise.resolve(null),
      ]);
      const summary = summarizeMonitorResources(
        resources,
        instance?.at ?? context.instanceAt ?? now,
      );
      const identity = mergeIdentity(currentProjection, {
        hostname: currentProjection?.hostname,
        machineId: currentProjection?.machineId,
        remoteAddress: currentProjection?.remoteAddress,
        keyId: currentProjection?.keyId,
      });

      nextProjection = {
        ...identity,
        connected: currentProjection?.connected ?? false,
        connectedAt: currentProjection?.connectedAt,
        lastProjectedAt: now,
        ...summary,
      };
      break;
    }
  }

  if (!nextProjection) return false;

  await writeMergedDaemonState(db, serverId, {
    key: existing.key,
    projection: nextProjection,
  }, touchLastSeen);

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
