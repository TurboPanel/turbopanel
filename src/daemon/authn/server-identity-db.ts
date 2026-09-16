import { eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import type { ServerMetadata } from "../../lib/db/server-metadata.ts";
import { normalizeMachineKey } from "../../lib/machine-key.ts";
import { key, server } from "../../lib/db/schema.ts";
import {
  buildDefaultDaemonStatus,
  mapServerDaemonStatusFromColumns,
  parseServerDaemonKeyRow,
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
  SERVER_KEY_REVOKED_ERROR,
} from "./daemon-state.ts";

export type ServerDaemonStateWithMetadata = ServerDaemonState & {
  status: ServerDaemonStatus;
  hostname: string | null;
  machineKey: string | null;
  metadata: ServerMetadata | null;
};

const STATUS_COLUMNS = {
  connected: server.isConnected,
  statusChangedAt: server.statusChangedAt,
} as const;

/**
 * Columns from the `key` table, selected alongside `server` columns.
 * `parseServerDaemonKeyRow` reads exactly these field names.
 */
const KEY_COLUMNS = {
  id: key.id,
  algorithm: key.algorithm,
  publicJwk: key.publicJwk,
  fingerprint: key.fingerprint,
  createdAt: key.createdAt,
  revokedAt: key.revokedAt,
  lastUsedAt: key.lastUsedAt,
} as const;

export async function getServerDaemonStateByServerId(
  db: Db,
  serverId: string,
): Promise<ServerDaemonStateWithMetadata | null> {
  // Inner join: no key row means "not enrolled" — the same predicate the
  // jsonb parse used to enforce by returning null on a missing `key`.
  const [row] = await db
    .select({
      daemon: server.daemon,
      metadata: server.metadata,
      hostname: server.hostname,
      machineKey: server.machineKey,
      ...STATUS_COLUMNS,
      ...KEY_COLUMNS,
    })
    .from(server)
    .innerJoin(key, eq(key.serverId, server.id))
    .where(eq(server.id, serverId))
    .limit(1);

  if (!row) return null;
  const parsedKey = parseServerDaemonKeyRow(row);
  if (!parsedKey) return null;
  const jsonbState = parseServerDaemonState(row.daemon);
  return {
    key: parsedKey,
    ...(jsonbState?.projection ? { projection: jsonbState.projection } : {}),
    status: mapServerDaemonStatusFromColumns(row),
    hostname: row.hostname ?? null,
    machineKey: row.machineKey ?? null,
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
      ...KEY_COLUMNS,
    })
    .from(key)
    .innerJoin(server, eq(server.id, key.serverId))
    .where(eq(key.fingerprint, fingerprint))
    .limit(1);

  if (!row) return null;
  const parsedKey = parseServerDaemonKeyRow(row);
  if (!parsedKey) return null;
  const jsonbState = parseServerDaemonState(row.daemon);
  return {
    key: parsedKey,
    ...(jsonbState?.projection ? { projection: jsonbState.projection } : {}),
    status: mapServerDaemonStatusFromColumns(row),
    serverId: row.serverId,
  };
}

/**
 * Thrown by {@link attachDaemonStateToServer} when the server's existing key
 * is revoked: the upsert's `setWhere` refused to overwrite it, atomically,
 * so a revoke committing between an enroll's pre-check and its write still
 * sticks. Callers map it to the enroll refusal.
 */
export class DaemonKeyRevokedError extends Error {
  constructor(readonly serverId: string) {
    super(`daemon key is revoked for server: ${serverId}`);
    this.name = "DaemonKeyRevokedError";
  }
}

export async function attachDaemonStateToServer(
  db: Db,
  serverId: string,
  params: {
    publicJwk: JsonWebKey;
    fingerprint: string;
    algorithm?: "Ed25519";
    hostname?: string | null;
    machineKey?: string | null;
  },
): Promise<{ keyId: string }> {
  const now = nowTs();
  const defaultStatus = buildDefaultDaemonStatus();
  const hostname = params.hostname?.trim() || null;
  const machineKey = normalizeMachineKey(params.machineKey) ?? null;
  const algorithm = params.algorithm ?? "Ed25519";

  // Insert-or-replace plus the server column write must land together: a
  // failure between them would leave a key row with stale server columns.
  return await db.transaction(async (tx) => {
    const [keyRow] = await tx
      .insert(key)
      .values({
        serverId,
        algorithm,
        publicJwk: params.publicJwk,
        fingerprint: params.fingerprint,
      })
      .onConflictDoUpdate({
        target: key.serverId,
        // Revocation is sticky at the row: a revoked key is never replaced
        // by re-enrollment, however the caller got here. Empty `returning`
        // below is that refusal, not a missing row.
        setWhere: isNull(key.revokedAt),
        set: {
          // Re-enrollment mints a new id too — it's a new key, not an edit
          // of the old row; `id` is the PK, so ON CONFLICT leaves it alone
          // unless explicitly reset here.
          id: sql`uuidv7()`,
          algorithm,
          publicJwk: params.publicJwk,
          fingerprint: params.fingerprint,
          createdAt: now,
          revokedAt: null,
          lastUsedAt: null,
          updatedAt: now,
        },
      })
      .returning({ id: key.id });

    if (!keyRow) {
      throw new DaemonKeyRevokedError(serverId);
    }

    const updated = await tx
      .update(server)
      .set({
        // Re-enrollment always resets projection too — a full replace, not
        // a merge, same as the old whole-jsonb write.
        daemon: null,
        ...(hostname ? { hostname } : {}),
        ...(machineKey ? { machineKey } : {}),
        isConnected: defaultStatus.connected,
        statusChangedAt: defaultStatus.statusChangedAt,
        updatedAt: now,
      })
      .where(eq(server.id, serverId))
      .returning({ id: server.id });

    if (updated.length === 0) {
      throw new Error(`server row missing for enroll attach: ${serverId}`);
    }

    return { keyId: keyRow.id };
  });
}

/**
 * Records daemon key use in Postgres — never wakes the daemon cell. A
 * targeted single-column write, not a read-modify-write: it cannot race
 * `revokeDaemonKey` the way the old whole-jsonb replace could.
 */
export async function touchDaemonKeyLastUsed(
  db: Db,
  serverId: string,
  at = nowTs(),
): Promise<void> {
  await db
    .update(key)
    .set({ lastUsedAt: at, updatedAt: at })
    .where(eq(key.serverId, serverId));
}

/** Targeted single-column write — see {@link touchDaemonKeyLastUsed}. */
export async function revokeDaemonKey(db: Db, serverId: string): Promise<void> {
  const now = nowTs();
  await db
    .update(key)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(key.serverId, serverId));
}

/**
 * Un-enrolls a server while leaving its row in place (re-enroll later
 * re-inserts a key). Deletes the `key` row explicitly rather than relying on
 * `ON DELETE CASCADE`, which only fires when the `server` row itself is
 * deleted — a caller that keeps the server row (e.g. freeing a colocated
 * license binding) must not leave a live key behind, or
 * `getServerDaemonStateByFingerprint` would still authenticate it.
 */
export async function clearServerDaemonState(
  db: Db,
  serverId: string,
): Promise<void> {
  const now = nowTs();
  const defaultStatus = buildDefaultDaemonStatus();
  await db.delete(key).where(eq(key.serverId, serverId));
  await db
    .update(server)
    .set({
      daemon: null,
      isConnected: defaultStatus.connected,
      statusChangedAt: defaultStatus.statusChangedAt,
      updatedAt: now,
    })
    .where(eq(server.id, serverId));
}
