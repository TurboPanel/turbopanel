import { generateSessionToken, SESSION_EXPIRES_IN_MS } from './crypto.ts'
import type { Db } from '../db.ts'
import { session, user } from '../db/schema.ts'
import { eq, and, gt } from 'drizzle-orm'

export const ROOT_USER_ID = '00000000-0000-0000-0000-000000000001'
export const ROOT_USERNAME = 'root'

export type SessionData = {
  sessionId: string
  userId: string
  username: string
}

export const rootSessionStore = new Map<string, { expiresAt: Date }>()

export function pruneExpiredRootSessions(): void {
  const now = new Date()
  for (const [token, entry] of rootSessionStore) {
    if (entry.expiresAt <= now) {
      rootSessionStore.delete(token)
    }
  }
}

export async function createSession(
  db: Db | undefined,
  userId: string,
  _username: string,
  meta: { ipAddress?: string | null; userAgent?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_MS)

  if (userId === ROOT_USER_ID) {
    pruneExpiredRootSessions()
    rootSessionStore.set(token, { expiresAt })
    return { token, expiresAt }
  }

  if (db === undefined) {
    throw new Error('Database unavailable')
  }

  await db.insert(session).values({
    token,
    userId,
    expiresAt: expiresAt.toISOString(),
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
  })

  return { token, expiresAt }
}

export async function getSession(
  db: Db | undefined,
  token: string,
): Promise<SessionData | null> {
  const rootEntry = rootSessionStore.get(token)
  if (rootEntry) {
    if (rootEntry.expiresAt > new Date()) {
      return {
        sessionId: 'root',
        userId: ROOT_USER_ID,
        username: ROOT_USERNAME,
      }
    }
    rootSessionStore.delete(token)
    return null
  }

  if (db === undefined) {
    return null
  }

  const rows = await db
    .select({
      sessionId: session.id,
      userId: session.userId,
      username: user.email,
    })
    .from(session)
    .innerJoin(user, eq(session.userId, user.id))
    .where(
      and(
        eq(session.token, token),
        gt(session.expiresAt, new Date().toISOString()),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    username: row.username,
  }
}

export async function deleteSession(
  db: Db | undefined,
  token: string,
): Promise<void> {
  rootSessionStore.delete(token)

  if (db !== undefined) {
    await db.delete(session).where(eq(session.token, token))
  }
}
