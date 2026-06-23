import { eq } from "drizzle-orm"
import type { Db } from "../../db.ts"
import { server } from "../../lib/db/schema.ts"

function nowTs(): string {
  return new Date().toISOString()
}

export interface ServerDaemonKey {
  daemonKeyId: string
  daemonKeyAlgorithm: string
  daemonPublicKey: JsonWebKey
  daemonKeyFingerprint: string
  daemonKeyCreatedAt: string
  daemonKeyLastUsedAt: string | null
  daemonKeyRevokedAt: string | null
}

type DaemonKeyRow = {
  daemonKeyId: string | null
  daemonKeyAlgorithm: string | null
  daemonPublicKey: unknown
  daemonKeyFingerprint: string | null
  daemonKeyCreatedAt: string | null
  daemonKeyLastUsedAt: string | null
  daemonKeyRevokedAt: string | null
}

function mapDaemonKeyRow(row: DaemonKeyRow): ServerDaemonKey | null {
  if (
    !row.daemonKeyId ||
    !row.daemonKeyAlgorithm ||
    !row.daemonPublicKey ||
    !row.daemonKeyFingerprint ||
    !row.daemonKeyCreatedAt
  ) {
    return null
  }

  return {
    daemonKeyId: row.daemonKeyId,
    daemonKeyAlgorithm: row.daemonKeyAlgorithm,
    daemonPublicKey: row.daemonPublicKey as JsonWebKey,
    daemonKeyFingerprint: row.daemonKeyFingerprint,
    daemonKeyCreatedAt: row.daemonKeyCreatedAt,
    daemonKeyLastUsedAt: row.daemonKeyLastUsedAt,
    daemonKeyRevokedAt: row.daemonKeyRevokedAt,
  }
}

const daemonKeySelect = {
  daemonKeyId: server.daemonKeyId,
  daemonKeyAlgorithm: server.daemonKeyAlgorithm,
  daemonPublicKey: server.daemonPublicKey,
  daemonKeyFingerprint: server.daemonKeyFingerprint,
  daemonKeyCreatedAt: server.daemonKeyCreatedAt,
  daemonKeyLastUsedAt: server.daemonKeyLastUsedAt,
  daemonKeyRevokedAt: server.daemonKeyRevokedAt,
}

export async function getServerDaemonKeyByServerId(
  db: Db,
  serverId: string,
): Promise<ServerDaemonKey | null> {
  const [row] = await db
    .select(daemonKeySelect)
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  if (!row) return null
  return mapDaemonKeyRow(row)
}

export async function getServerDaemonKeyByFingerprint(
  db: Db,
  fingerprint: string,
): Promise<(ServerDaemonKey & { serverId: string }) | null> {
  const [row] = await db
    .select({
      serverId: server.id,
      ...daemonKeySelect,
    })
    .from(server)
    .where(eq(server.daemonKeyFingerprint, fingerprint))
    .limit(1)

  if (!row) return null
  const key = mapDaemonKeyRow(row)
  if (!key) return null
  return { ...key, serverId: row.serverId }
}

export async function attachDaemonKeyToServer(
  db: Db,
  serverId: string,
  params: {
    publicJwk: JsonWebKey
    fingerprint: string
    algorithm?: string
  },
): Promise<{ daemonKeyId: string }> {
  const now = nowTs()
  const [existing] = await db
    .select({ daemonKeyId: server.daemonKeyId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const daemonKeyId = existing?.daemonKeyId ?? crypto.randomUUID()

  await db
    .update(server)
    .set({
      daemonKeyId,
      daemonKeyAlgorithm: params.algorithm ?? "Ed25519",
      daemonPublicKey: params.publicJwk,
      daemonKeyFingerprint: params.fingerprint,
      daemonKeyCreatedAt: now,
      daemonKeyLastUsedAt: null,
      daemonKeyRevokedAt: null,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))

  return { daemonKeyId }
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

export async function revokeDaemonKey(db: Db, serverId: string): Promise<void> {
  const now = nowTs()
  await db
    .update(server)
    .set({
      daemonKeyRevokedAt: now,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))
}
