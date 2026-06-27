import type { Db } from "../../db.ts";
import type { DaemonCell } from "./contracts.ts";
import type { MonitorEvent } from "./monitor-contracts.ts";
import type { DaemonInboundEnvelope } from "./protocol.ts";
import { incrementMonitorCounter } from "./monitor-observability.ts";
import {
  identityFromSnapshot,
  isMeaningfulMonitorTransition,
  projectServerDaemon,
  type ProjectionAgent,
} from "./postgres-projection.ts";

export async function onDaemonConnected(
  db: Db,
  serverId: string,
  cell: DaemonCell,
  connectedAt?: string,
): Promise<void> {
  const snapshot = await cell.getSnapshot();
  await projectServerDaemon(db, serverId, {
    kind: "online",
    identity: identityFromSnapshot(snapshot),
    connectedAt: connectedAt ?? snapshot.connectedAt,
  }, { cell });
}

export async function onDaemonDisconnected(
  db: Db,
  serverId: string,
  cell?: DaemonCell,
): Promise<void> {
  await projectServerDaemon(db, serverId, { kind: "disconnected" }, { cell });
}

function extractAgent(msg: DaemonInboundEnvelope): ProjectionAgent | undefined {
  if (msg.kind !== "monitor-sync" && msg.kind !== "monitor-heartbeat") {
    return undefined;
  }
  const agent = msg.agent;
  if (!agent?.commit || !agent?.buildId) return undefined;
  return {
    commit: agent.commit,
    buildId: agent.buildId,
    builtAt: agent.builtAt,
    channel: agent.channel,
  };
}

export async function onMonitorMessageApplied(
  db: Db,
  serverId: string,
  cell: DaemonCell,
  kind: "monitor-sync" | "monitor-heartbeat" | "monitor-transition",
  msg: DaemonInboundEnvelope,
): Promise<void> {
  incrementMonitorCounter("monitorMessagesAccepted");

  if (kind === "monitor-sync") {
    incrementMonitorCounter("monitorFullSync");
  } else if (kind === "monitor-heartbeat") {
    incrementMonitorCounter("monitorDeltaHeartbeat");
  }

  const agent = extractAgent(msg);
  const projectionContext = { cell, agent };

  const events = extractMonitorEvents(msg);
  const meaningful = events.filter(isMeaningfulMonitorTransition);
  if (meaningful.length > 0) {
    await projectServerDaemon(
      db,
      serverId,
      { kind: "resource_transition", events: meaningful },
      projectionContext,
    );
    return;
  }

  if (kind === "monitor-sync") {
    const wrote = await projectServerDaemon(
      db,
      serverId,
      { kind: "summary_refresh" },
      projectionContext,
    );
    if (!wrote && agent) {
      await projectServerDaemon(db, serverId, { kind: "agent", agent });
    }
    return;
  }

  if (kind === "monitor-heartbeat" && agent) {
    await projectServerDaemon(db, serverId, { kind: "agent", agent });
  }
}

function extractMonitorEvents(msg: DaemonInboundEnvelope): MonitorEvent[] {
  if (msg.kind === "monitor-transition") return msg.events;
  if (msg.kind === "monitor-sync" || msg.kind === "monitor-heartbeat") {
    return msg.events ?? [];
  }
  return [];
}

export async function projectIdentityIfChanged(
  db: Db,
  serverId: string,
  cell: DaemonCell,
): Promise<void> {
  const snapshot = await cell.getSnapshot();
  await projectServerDaemon(db, serverId, {
    kind: "identity",
    identity: identityFromSnapshot(snapshot),
  }, { cell });
}
