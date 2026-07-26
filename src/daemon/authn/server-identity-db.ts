import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import { server } from "../../lib/db/schema.ts";
import {
  buildDefaultDaemonStatus,
  buildServerDaemonState,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
  type ServerDaemonState,
  type ServerDaemonStatus,
} from "./daemon-state.ts";

function nowTs(): string {
  return new Date().toISOString();
}

export type { ServerDaemonKey, ServerDaemonState, ServerDaemonStatus } from "./daemon-state.ts";
export {
  buildDefaultDaemonStatus,
  isDaemonKeyActive,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonState,
} from "./daemon-state.ts";

export type ServerDaemonStateWithMetadata = ServerDaemonState & {
  status: ServerDaemonStatus;
  hostname: string | null;
  machineId: string | null;
  metadata: ServerMetadata | null;
};

const STATUS_COLUMNS = {
  connected: server.connected,
  daemonStatus: server.daemonStatus,
  lastSeenAt: server.lastSeenAt,
  connectedAt: server.connectedAt,
  disconnectedAt: server.disconnectedAt,
  statusChangedAt: server.statusChangedAt,
} as const;

export async function getServerDaemonStateByServerId(
  db: Db,
  serverId: string,
): Promise<ServerDaemonStateWithMetadata | null> {
  const [row] = await db
    .select({
      daemon: server.daemon,
      metadata: server.metadata,
      hostname: server.hostname,
      machineId: server.machineId,
      ...STATUS_COLUMNS,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1);

  if (!row) return null;
  const state = parseServerDaemonState(row.daemon);
  if (!state) return null;
  return {
    ...state,
    status: mapServerDaemonStatusFromColumns(row),
    hostname: row.hostname ?? null,
    machineId: row.machineId ?? null,
    metadata: (row.metadata ?? null) as ServerMetadata | null,
  };
}

export async function getServerDaemonStateByFingerprint(
  db: Db,
  fingerprint: string,
): Promise<(ServerDaemonState & { serverId: string; status: ServerDaemonStatus }) | null> {
  const [row] = await db
    .select({
      serverId: server.id,
      daemon: server.daemon,
      ...STATUS_COLUMNS,
    })
    .from(server)
    .where(sql`${server.daemon}->'key'->>'fingerprint' = ${fingerprint}`)
    .limit(1);

  if (!row) return null;
  const state = parseServerDaemonState(row.daemon);
  if (!state) return null;
  return {
    ...state,
    status: mapServerDaemonStatusFromColumns(row),
    serverId: row.serverId,
  };
}

export async function attachDaemonStateToServer(
  db: Db,
  serverId: string,
  params: {
    publicJwk: JsonWebKey;
    fingerprint: string;
    algorithm?: "Ed25519";
    hostname?: string | null;
    machineId?: string | null;
  },
): Promise<{ keyId: string }> {
  const now = nowTs();
  const daemonState = buildServerDaemonState(params);
  const defaultStatus = buildDefaultDaemonStatus();
  const hostname = params.hostname?.trim() || null;
  const machineId = params.machineId?.trim() || null;

  const updated = await db
    .update(server)
    .set({
      daemon: daemonState,
      ...(hostname ? { hostname } : {}),
      ...(machineId ? { machineId } : {}),
      connected: defaultStatus.connected,
      daemonStatus: defaultStatus.daemonStatus ?? "unknown",
      lastSeenAt: defaultStatus.lastSeenAt,
      connectedAt: defaultStatus.connectedAt,
      disconnectedAt: defaultStatus.disconnectedAt,
      statusChangedAt: defaultStatus.statusChangedAt,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))
    .returning({ id: server.id });

  if (updated.length === 0) {
    throw new Error(`server row missing for enroll attach: ${serverId}`);
  }

  return { keyId: daemonState.key.id };
}

async function updateServerDaemonState(
  db: Db,
  serverId: string,
  updater: (state: ServerDaemonState) => ServerDaemonState,
): Promise<boolean> {
  const existing = await getServerDaemonStateByServerId(db, serverId);
  if (!existing) return false;

  const daemonState: ServerDaemonState = {
    key: existing.key,
    ...(existing.projection ? { projection: existing.projection } : {}),
  };

  const now = nowTs();
  await db
    .update(server)
    .set({
      daemon: updater(daemonState),
      updatedAt: now,
    })
    .where(eq(server.id, serverId));

  return true;
}

/** Records daemon key use in Postgres — never wakes the daemon cell. */
export async function touchDaemonKeyLastUsed(
  db: Db,
  serverId: string,
  at = nowTs(),
): Promise<void> {
  await updateServerDaemonState(db, serverId, (state) => ({
    ...state,
    key: {
      ...state.key,
      lastUsedAt: at,
    },
  }));
}

export async function revokeDaemonKey(db: Db, serverId: string): Promise<void> {
  const now = nowTs();
  await updateServerDaemonState(db, serverId, (state) => ({
    ...state,
    key: {
      ...state.key,
      revokedAt: now,
    },
  }));
}

export async function clearServerDaemonState(
  db: Db,
  serverId: string,
): Promise<void> {
  const now = nowTs();
  const defaultStatus = buildDefaultDaemonStatus();
  await db
    .update(server)
    .set({
      daemon: null,
      connected: defaultStatus.connected,
      daemonStatus: defaultStatus.daemonStatus ?? "unknown",
      lastSeenAt: defaultStatus.lastSeenAt,
      connectedAt: defaultStatus.connectedAt,
      disconnectedAt: defaultStatus.disconnectedAt,
      statusChangedAt: defaultStatus.statusChangedAt,
      updatedAt: now,
    })
    .where(eq(server.id, serverId));
}
