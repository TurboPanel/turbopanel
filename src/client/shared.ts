import type { Context } from 'hono'
import { getDb } from '../db.ts'
import { can } from './authz/index.ts'
import { resolveOrgId } from './org-context.ts'

export const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]+$/

export class BadRequestError extends Error {}

export async function getOrgId(c: Context, userId: string): Promise<string | Response> {
  return resolveOrgId(c, userId)
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

export function parseDescription(body: Record<string, unknown>): string | null {
  if (body.description === undefined) {
    return null
  }
  if (typeof body.description !== 'string') {
    throw new BadRequestError('Invalid request')
  }
  if (body.description.length > 255) {
    throw new BadRequestError('Invalid request')
  }
  return body.description
}

export function parseJsonbObject(
  c: Context,
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null | Response {
  if (body[field] === undefined) {
    return null
  }
  const value = body[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value as Record<string, unknown>
}

/** PATCH payload: omit `displayName` when absent so partial updates do not clear it. */
export function buildPatchUpdateFields(
  body: Record<string, unknown>,
): { displayName?: string | null; description?: string | null; updatedAt: string } {
  const updatedAt = new Date().toISOString()
  const result: {
    displayName?: string | null
    description?: string | null
    updatedAt: string
  } = { updatedAt }

  if (body.displayName !== undefined) {
    if (typeof body.displayName !== 'string') {
      throw new BadRequestError('Invalid request')
    }
    const name = body.displayName
    if (name.length < 1 || name.length > 255 || !DISPLAY_NAME_RE.test(name)) {
      throw new BadRequestError('Invalid request')
    }
    result.displayName = name
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      throw new BadRequestError('Invalid request')
    }
    if (body.description.length > 255) {
      throw new BadRequestError('Invalid request')
    }
    result.description = body.description
  }

  return result
}

/** Read access: org owners/managers and platform admins may read any entity in the org. */
export async function assertCanReadOr403(
  c: Context,
  kind: string,
  entityId: string,
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const allowed = await can(db, session.userId, 'organization:own', kind, entityId)

  if (!allowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return null
}

/** Manage access: org managers and platform admins may manage entities in the org. */
export async function assertCanManageOr403(
  c: Context,
  kind: string,
  entityId: string,
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const allowed = await can(db, session.userId, 'organization:manage', kind, entityId)

  if (!allowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return null
}

/** Create access: org owners/managers and platform admins may create under the parent scope. */
export async function assertCanCreateOr403(
  c: Context,
  parentKind: string,
  parentId: string,
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const allowed = await can(db, session.userId, 'organization:own', parentKind, parentId)
  if (!allowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return null
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
