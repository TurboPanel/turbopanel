import { generateSessionToken, SESSION_EXPIRES_IN_MS } from './crypto.ts'
import type { Db } from '../../db.ts'
import { session, user } from '../../lib/db/schema.ts'
import { eq, and, gt } from 'drizzle-orm'

export const SUPERADMIN_ROLE = 'superadmin'

export function isSuperadminRole(role: string | null | undefined): boolean {
  return role === SUPERADMIN_ROLE
}

export const ADMIN_ROLE = 'admin'

export function isAdminRole(role: string | null | undefined): boolean {
  return role === SUPERADMIN_ROLE || role === ADMIN_ROLE
}

export type SessionData = {
  sessionId: string
  userId: string
  username: string | null
  email: string
  role: string
  organizationId: string | null
}

export async function createSession(
  db: Db | undefined,
  userId: string,
  meta: {
    ipAddress?: string | null
    userAgent?: string | null
    organizationId?: string | null
  },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN_MS)

  if (db === undefined) {
    throw new Error('Database unavailable')
  }

  // Root sessions are DB-backed on Deno (createDenoDb() in deno.ts always provides db).
  // This guard cannot trigger in practice on Deno; Workers has no DB and never reaches here.
  await db.insert(session).values({
    token,
    userId,
    expiresAt: expiresAt.toISOString(),
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
    organizationId: meta.organizationId ?? null,
  })

  return { token, expiresAt }
}

export async function getSession(
  db: Db | undefined,
  token: string,
): Promise<SessionData | null> {
  if (db === undefined) {
    return null
  }

  const rows = await db
    .select({
      sessionId: session.id,
      userId: session.userId,
      username: user.username,
      email: user.email,
      role: user.role,
      organizationId: session.organizationId,
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
    email: row.email,
    role: row.role,
    organizationId: row.organizationId,
  }
}

export async function deleteSession(
  db: Db | undefined,
  token: string,
): Promise<void> {
  if (db !== undefined) {
    await db.delete(session).where(eq(session.token, token))
  }
}

/** Point the active session at an organization (e.g. after accepting an invite). */
export async function updateSessionOrganization(
  db: Db,
  sessionId: string,
  organizationId: string,
): Promise<void> {
  await db
    .update(session)
    .set({
      organizationId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(session.id, sessionId))
}
