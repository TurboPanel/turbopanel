import { eq, sql } from "drizzle-orm"
import type { Db } from "../../db.ts"
import { server } from "../../lib/db/schema.ts"
import {
  buildServerDaemonState,
  parseServerDaemonState,
  type ServerDaemonState,
} from "./daemon-state.ts"

function nowTs(): string {
  return new Date().toISOString()
}

export type { ServerDaemonKey, ServerDaemonState } from "./daemon-state.ts"
export { isDaemonKeyActive, parseServerDaemonState } from "./daemon-state.ts"

export async function getServerDaemonStateByServerId(
  db: Db,
  serverId: string,
): Promise<ServerDaemonState | null> {
  const [row] = await db
    .select({ daemon: server.daemon })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  if (!row) return null
  return parseServerDaemonState(row.daemon)
}

export async function getServerDaemonStateByFingerprint(
  db: Db,
  fingerprint: string,
): Promise<(ServerDaemonState & { serverId: string }) | null> {
  const [row] = await db
    .select({
      serverId: server.id,
      daemon: server.daemon,
    })
    .from(server)
    .where(sql`${server.daemon}->'key'->>'fingerprint' = ${fingerprint}`)
    .limit(1)

  if (!row) return null
  const state = parseServerDaemonState(row.daemon)
  if (!state) return null
  return { ...state, serverId: row.serverId }
}

export async function attachDaemonStateToServer(
  db: Db,
  serverId: string,
  params: {
    publicJwk: JsonWebKey
    fingerprint: string
    algorithm?: "Ed25519"
  },
): Promise<{ keyId: string }> {
  const now = nowTs()
  const daemonState = buildServerDaemonState(params)

  await db
    .update(server)
    .set({
      daemon: daemonState,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))

  return { keyId: daemonState.key.id }
}

async function updateServerDaemonState(
  db: Db,
  serverId: string,
  updater: (state: ServerDaemonState) => ServerDaemonState,
): Promise<boolean> {
  const existing = await getServerDaemonStateByServerId(db, serverId)
  if (!existing) return false

  const now = nowTs()
  await db
    .update(server)
    .set({
      daemon: updater(existing),
      updatedAt: now,
    })
    .where(eq(server.id, serverId))

  return true
}

export async function touchDaemonKeyLastUsed(
  db: Db,
  serverId: string,
): Promise<void> {
  const now = nowTs()
  await db
    .update(server)
    .set({
      daemonKeyLastUsedAt: now,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))
}

export async function touchDaemonLastSeen(
  db: Db,
  serverId: string,
): Promise<void> {
  const now = nowTs()
  await db
    .update(server)
    .set({
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))
}

export async function touchDaemonKeyLastUsedAndLastSeen(
  db: Db,
  serverId: string,
): Promise<void> {
  const now = nowTs()
  await db
    .update(server)
    .set({
      daemonKeyLastUsedAt: now,
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))
}

export async function revokeDaemonKey(db: Db, serverId: string): Promise<void> {
  const now = nowTs()
  await updateServerDaemonState(db, serverId, (state) => ({
    ...state,
    key: {
      ...state.key,
      revokedAt: now,
    },
  }))
}

export async function clearServerDaemonState(
  db: Db,
  serverId: string,
): Promise<void> {
  const now = nowTs()
  await db
    .update(server)
    .set({
      daemon: null,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))
}
