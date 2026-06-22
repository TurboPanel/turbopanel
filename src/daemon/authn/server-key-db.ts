import { and, eq, isNull, or, sql } from "drizzle-orm"
import type { Db } from "../../db.ts"
import { serverkey } from "../../lib/db/schema.ts"

export interface ServerKeyRow {
  id: string
  createdAt: string
  updatedAt: string
  serverId: string
  algorithm: string
  publicKey: JsonWebKey
  fingerprint: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export async function findActiveServerKeys(
  db: Db,
  serverId: string,
): Promise<ServerKeyRow[]> {
  const rows = await db
    .select()
    .from(serverkey)
    .where(
      and(
        eq(serverkey.serverId, serverId),
        isNull(serverkey.revokedAt),
        or(
          isNull(serverkey.expiresAt),
          sql`${serverkey.expiresAt} > now()`,
        ),
      ),
    )

  return rows as ServerKeyRow[]
}

export async function findServerKeyById(
  db: Db,
  keyId: string,
): Promise<ServerKeyRow | null> {
  const [row] = await db
    .select()
    .from(serverkey)
    .where(eq(serverkey.id, keyId))
    .limit(1)

  return (row as ServerKeyRow | undefined) ?? null
}

export async function findServerKeyByFingerprint(
  db: Db,
  fingerprint: string,
): Promise<ServerKeyRow | null> {
  const [row] = await db
    .select()
    .from(serverkey)
    .where(eq(serverkey.fingerprint, fingerprint))
    .limit(1)

  return (row as ServerKeyRow | undefined) ?? null
}

export async function insertServerKey(
  db: Db,
  params: {
    serverId: string
    publicJwk: JsonWebKey
    fingerprint: string
    algorithm?: string
  },
): Promise<ServerKeyRow> {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(serverkey)
    .values({
      createdAt: now,
      updatedAt: now,
      serverId: params.serverId,
      algorithm: params.algorithm ?? "Ed25519",
      publicKey: params.publicJwk,
      fingerprint: params.fingerprint,
    })
    .returning()

  return row as ServerKeyRow
}

export async function touchServerKeyLastUsed(
  db: Db,
  keyId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .update(serverkey)
    .set({
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(eq(serverkey.id, keyId))
}

export async function revokeServerKey(db: Db, keyId: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .update(serverkey)
    .set({
      revokedAt: now,
      updatedAt: now,
    })
    .where(eq(serverkey.id, keyId))
}
