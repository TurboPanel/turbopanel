import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import {
  access,
  organization,
  resource,
  team,
  user,
} from '../db/schema.ts'
import { isAccessProfileKey, isPermissionKey } from './catalog.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CreateAccessGrantInput = {
  subjectKind: 'user' | 'team' | 'organization'
  subjectId: string
  resourceId: string
  effect: 'allow' | 'deny'
  accessProfileKey?: string
  permissionKey?: string
}

export type CreateAccessGrantResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string }

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

async function resolveSubject(
  db: Db,
  subjectKind: CreateAccessGrantInput['subjectKind'],
  subjectId: string,
  resourceOrganizationId: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }> {
  if (subjectKind === 'user') {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, subjectId))
      .limit(1)
    if (rows.length === 0) {
      return { ok: false, status: 404, error: 'User not found' }
    }
    return { ok: true }
  }

  if (subjectKind === 'team') {
    const rows = await db
      .select({ id: team.id, organizationId: team.organizationId })
      .from(team)
      .where(eq(team.id, subjectId))
      .limit(1)
    const row = rows[0]
    if (!row) {
      return { ok: false, status: 404, error: 'Team not found' }
    }
    if (row.organizationId !== resourceOrganizationId) {
      return {
        ok: false,
        status: 400,
        error: 'Team must belong to the same organization as the resource',
      }
    }
    return { ok: true }
  }

  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, subjectId))
    .limit(1)
  if (rows.length === 0) {
    return { ok: false, status: 404, error: 'Organization not found' }
  }
  if (subjectId !== resourceOrganizationId) {
    return {
      ok: false,
      status: 400,
      error: 'Organization subject must match the resource organization',
    }
  }
  return { ok: true }
}

export async function createAccessGrant(
  db: Db,
  input: CreateAccessGrantInput,
): Promise<CreateAccessGrantResult> {
  if (!isUuid(input.subjectId) || !isUuid(input.resourceId)) {
    return { ok: false, status: 400, error: 'Invalid request' }
  }

  const hasAccessProfileKey =
    typeof input.accessProfileKey === 'string' && input.accessProfileKey.length > 0
  const hasPermissionKey =
    typeof input.permissionKey === 'string' && input.permissionKey.length > 0
  if (hasAccessProfileKey === hasPermissionKey) {
    return {
      ok: false,
      status: 400,
      error: 'Exactly one of accessProfileKey or permissionKey is required',
    }
  }

  if (hasAccessProfileKey && !isAccessProfileKey(input.accessProfileKey!)) {
    return { ok: false, status: 400, error: 'Invalid access profile key' }
  }
  if (hasPermissionKey && !isPermissionKey(input.permissionKey!)) {
    return { ok: false, status: 400, error: 'Invalid permission key' }
  }

  const resourceRows = await db
    .select({
      id: resource.id,
      organizationId: resource.organizationId,
    })
    .from(resource)
    .where(eq(resource.id, input.resourceId))
    .limit(1)

  const resourceRow = resourceRows[0]
  if (!resourceRow) {
    return { ok: false, status: 404, error: 'Resource not found' }
  }

  const subjectResult = await resolveSubject(
    db,
    input.subjectKind,
    input.subjectId,
    resourceRow.organizationId,
  )
  if (!subjectResult.ok) {
    return subjectResult
  }

  const values = {
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    resourceId: input.resourceId,
    effect: input.effect,
    accessProfileKey: hasAccessProfileKey ? input.accessProfileKey! : null,
    permissionKey: hasPermissionKey ? input.permissionKey! : null,
  }

  if (hasAccessProfileKey) {
    const inserted = await db
      .insert(access)
      .values({ ...values, permissionKey: null })
      .onConflictDoNothing({
        target: [
          access.subjectKind,
          access.subjectId,
          access.resourceId,
          access.accessProfileKey,
        ],
        where: sql`${access.accessProfileKey} IS NOT NULL`,
      })
      .returning({ id: access.id })

    const id = inserted[0]?.id
    if (id) {
      return { ok: true, id, created: true }
    }

    const existing = await db
      .select({ id: access.id })
      .from(access)
      .where(and(
        eq(access.subjectKind, input.subjectKind),
        eq(access.subjectId, input.subjectId),
        eq(access.resourceId, input.resourceId),
        eq(access.accessProfileKey, input.accessProfileKey!),
      ))
      .limit(1)

    const existingId = existing[0]?.id
    if (!existingId) {
      return { ok: false, status: 409, error: 'Access grant conflict' }
    }

    return { ok: true, id: existingId, created: false }
  }

  const inserted = await db
    .insert(access)
    .values({ ...values, accessProfileKey: null })
    .onConflictDoNothing({
      target: [
        access.subjectKind,
        access.subjectId,
        access.resourceId,
        access.permissionKey,
      ],
      where: sql`${access.permissionKey} IS NOT NULL`,
    })
    .returning({ id: access.id })

  const id = inserted[0]?.id
  if (id) {
    return { ok: true, id, created: true }
  }

  const existing = await db
    .select({ id: access.id })
    .from(access)
    .where(and(
      eq(access.subjectKind, input.subjectKind),
      eq(access.subjectId, input.subjectId),
      eq(access.resourceId, input.resourceId),
      eq(access.permissionKey, input.permissionKey!),
    ))
    .limit(1)

  const existingId = existing[0]?.id
  if (!existingId) {
    return { ok: false, status: 409, error: 'Access grant conflict' }
  }

  return { ok: true, id: existingId, created: false }
}
