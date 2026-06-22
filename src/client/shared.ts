import type { Context } from 'hono'
import { getDb } from '../db.ts'
import { can } from './authz/index.ts'
import type { PermissionKey } from './authz/index.ts'
import type { SessionData } from './authn/middleware.ts'

export const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]+$/

export class BadRequestError extends Error {}

export function getOrgId(c: Context, session: SessionData): string | Response {
  const { organizationId } = session
  if (!organizationId) {
    return c.json({ error: 'No organization' }, 400)
  }
  return organizationId
}

export function parseDisplayName(body: Record<string, unknown>): string | null {
  if (body.displayName === undefined) {
    return null
  }
  if (typeof body.displayName !== 'string') {
    throw new BadRequestError('Invalid request')
  }
  const name = body.displayName
  if (name.length < 1 || name.length > 255 || !DISPLAY_NAME_RE.test(name)) {
    throw new BadRequestError('Invalid request')
  }
  return name
}

/** PATCH payload: omit `displayName` when absent so partial updates do not clear it. */
export function buildPatchUpdateFields(
  body: Record<string, unknown>,
): { displayName?: string | null; updatedAt: string } {
  const updatedAt = new Date().toISOString()
  if (body.displayName === undefined) {
    return { updatedAt }
  }
  if (typeof body.displayName !== 'string') {
    throw new BadRequestError('Invalid request')
  }
  const name = body.displayName
  if (name.length < 1 || name.length > 255 || !DISPLAY_NAME_RE.test(name)) {
    throw new BadRequestError('Invalid request')
  }
  return { displayName: name, updatedAt }
}

/** Read access: allow when either `<kind>:ro` or `<kind>:rw` is granted (matches listVisible). */
export async function assertCanReadOr403(
  c: Context,
  kind: string,
  entityId: string,
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const roKey = `${kind}:ro` as PermissionKey
  const rwKey = `${kind}:rw` as PermissionKey
  const allowed =
    (await can(db, session.userId, roKey, kind, entityId)) ||
    (await can(db, session.userId, rwKey, kind, entityId))

  if (!allowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return null
}

/** Create access: allow when any listed permission is granted on the parent scope. */
export async function assertCanCreateOr403(
  c: Context,
  parentKind: string,
  parentId: string,
  permissionKeys: PermissionKey[],
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  for (const key of permissionKeys) {
    if (await can(db, session.userId, key, parentKind, parentId)) {
      return null
    }
  }
  return c.json({ error: 'Forbidden' }, 403)
}

export async function parseJsonBody(
  c: Context,
): Promise<Record<string, unknown> | Response> {
  const rawBody = await c.req.text().catch(() => '')
  if (!rawBody.trim()) {
    return {}
  }
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return body as Record<string, unknown>
}

export function requireStringField(
  c: Context,
  body: Record<string, unknown>,
  field: string,
): string | Response {
  const value = body[field]
  if (typeof value !== 'string' || !value) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}
