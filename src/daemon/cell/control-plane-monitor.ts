import type { Db } from "../../db.ts";
import type { DaemonCell } from "./contracts.ts";
import {
  identityFromSnapshot,
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

export async function onDaemonHeartbeat(
  db: Db,
  serverId: string,
  _cell: DaemonCell,
  agent?: ProjectionAgent,
): Promise<void> {
  if (!agent?.commit || !agent?.buildId) return;
  await projectServerDaemon(db, serverId, { kind: "agent", agent });
}
