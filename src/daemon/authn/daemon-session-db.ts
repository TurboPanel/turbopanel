import { and, eq, isNull, sql } from "drizzle-orm"
import type { Db } from "../../db.ts"
import { daemonsession } from "../../lib/db/schema.ts"

export interface DaemonSessionRow {
  id: string
  createdAt: string
  updatedAt: string
  serverId: string
  serverKeyId: string
  lastUsedAt: string | null
  expiresAt: string
  revokedAt: string | null
}

export async function insertDaemonSession(
  db: Db,
  params: {
    serverId: string
    serverKeyId: string
    expiresAt: string
  },
): Promise<{ id: string }> {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(daemonsession)
    .values({
      createdAt: now,
      updatedAt: now,
      serverId: params.serverId,
      serverKeyId: params.serverKeyId,
      expiresAt: params.expiresAt,
    })
    .returning({ id: daemonsession.id })

  return { id: row.id }
}

export async function touchDaemonSessionLastUsed(
  db: Db,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .update(daemonsession)
    .set({
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(eq(daemonsession.id, sessionId))
}

export async function revokeDaemonSession(
  db: Db,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .update(daemonsession)
    .set({
      revokedAt: now,
      updatedAt: now,
    })
    .where(eq(daemonsession.id, sessionId))
}

export async function findActiveDaemonSession(
  db: Db,
  sessionId: string,
): Promise<DaemonSessionRow | null> {
  const [row] = await db
    .select()
    .from(daemonsession)
    .where(
      and(
        eq(daemonsession.id, sessionId),
        isNull(daemonsession.revokedAt),
        sql`${daemonsession.expiresAt} > now()`,
      ),
    )
    .limit(1)

  return (row as DaemonSessionRow | undefined) ?? null
}
