import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db.ts'
import {
  accessGrant,
  environment,
  hosting,
  organization,
  project,
  realm,
  server,
  service,
  team,
  user,
} from '../db/schema.ts'
import {
  ACCESS_PROFILES,
  isAccessProfileKey,
  isPermissionKey,
  RESOURCE_KINDS,
  type AccessProfileKey,
  type PermissionKey,
} from './catalog.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CreateAccessGrantInput = {
  subjectType: 'user' | 'team' | 'organization'
  subjectId: string
  entityType: string
  entityId: string
  allowed?: boolean
  accessProfileKey?: string
  permissionKey?: string
}

export type CreateAccessGrantResult =
  | { ok: true; ids: string[]; created: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string }

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function isResourceKind(value: string): value is (typeof RESOURCE_KINDS)[number] {
  return (RESOURCE_KINDS as readonly string[]).includes(value)
}

export async function verifyEntityExists(
  db: Db,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  switch (entityType) {
    case 'organization': {
      const rows = await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'realm': {
      const rows = await db
        .select({ id: realm.id })
        .from(realm)
        .where(eq(realm.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'environment': {
      const rows = await db
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'project': {
      const rows = await db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'service': {
      const rows = await db
        .select({ id: service.id })
        .from(service)
        .where(eq(service.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'hosting': {
      const rows = await db
        .select({ id: hosting.id })
        .from(hosting)
        .where(eq(hosting.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'server': {
      const rows = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    default:
      return false
  }
}

export type ValidateGrantEntityTargetResult =
  | { ok: true; organizationId: string }
  | { ok: false; status: 400 | 404; error: string }

/** Confirm the entity exists and optionally belongs to the expected organization. */
export async function validateGrantEntityTarget(
  db: Db,
  entityType: string,
  entityId: string,
  expectedOrganizationId?: string,
): Promise<ValidateGrantEntityTargetResult> {
  if (!isResourceKind(entityType)) {
    return { ok: false, status: 404, error: 'Entity not found' }
  }

  if (!isUuid(entityId)) {
    return { ok: false, status: 404, error: 'Entity not found' }
  }

  const entityExists = await verifyEntityExists(db, entityType, entityId)
  if (!entityExists) {
    return { ok: false, status: 404, error: 'Entity not found' }
  }

  const organizationId = await resolveEntityOrganizationId(db, entityType, entityId)
  if (!organizationId) {
    return { ok: false, status: 404, error: 'Entity not found' }
  }

  if (
    expectedOrganizationId !== undefined &&
    organizationId !== expectedOrganizationId
  ) {
    return {
      ok: false,
      status: 400,
      error: 'Entity must belong to the invitation organization',
    }
  }

  return { ok: true, organizationId }
}

export async function resolveEntityOrganizationId(
  db: Db,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case 'organization':
      return entityId
    case 'realm': {
      const rows = await db
        .select({ organizationId: realm.organizationId })
        .from(realm)
        .where(eq(realm.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'environment': {
      const rows = await db
        .select({ organizationId: environment.organizationId })
        .from(environment)
        .where(eq(environment.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'project': {
      const rows = await db
        .select({ organizationId: project.organizationId })
        .from(project)
        .where(eq(project.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'service': {
      const rows = await db
        .select({ organizationId: service.organizationId })
        .from(service)
        .where(eq(service.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'hosting': {
      const rows = await db
        .select({ organizationId: hosting.organizationId })
        .from(hosting)
        .where(eq(hosting.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'server': {
      const rows = await db
        .select({ organizationId: server.organizationId })
        .from(server)
        .where(eq(server.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    default:
      return null
  }
}

async function resolveSubject(
  db: Db,
  subjectType: CreateAccessGrantInput['subjectType'],
  subjectId: string,
  entityOrganizationId: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }> {
  if (subjectType === 'user') {
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

  if (subjectType === 'team') {
    const rows = await db
      .select({ id: team.id, organizationId: team.organizationId })
      .from(team)
      .where(eq(team.id, subjectId))
      .limit(1)
    const row = rows[0]
    if (!row) {
      return { ok: false, status: 404, error: 'Team not found' }
    }
    if (row.organizationId !== entityOrganizationId) {
      return {
        ok: false,
        status: 400,
        error: 'Team must belong to the same organization as the entity',
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
  if (subjectId !== entityOrganizationId) {
    return {
      ok: false,
      status: 400,
      error: 'Organization subject must match the entity organization',
    }
  }
  return { ok: true }
}

export async function createAccessGrant(
  db: Db,
  input: CreateAccessGrantInput,
): Promise<CreateAccessGrantResult> {
  if (!isResourceKind(input.entityType)) {
    return { ok: false, status: 400, error: 'Invalid entity type' }
  }

  if (
    input.subjectType !== 'user' &&
    input.subjectType !== 'team' &&
    input.subjectType !== 'organization'
  ) {
    return { ok: false, status: 400, error: 'Invalid request' }
  }

  if (!isUuid(input.entityId) || !isUuid(input.subjectId)) {
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

  const entityResult = await validateGrantEntityTarget(
    db,
    input.entityType,
    input.entityId,
  )
  if (!entityResult.ok) {
    return entityResult
  }

  const entityOrganizationId = entityResult.organizationId

  const subjectResult = await resolveSubject(
    db,
    input.subjectType,
    input.subjectId,
    entityOrganizationId,
  )
  if (!subjectResult.ok) {
    return subjectResult
  }

  const allowed = input.allowed ?? true

  if (hasAccessProfileKey) {
    const profileKey = input.accessProfileKey! as AccessProfileKey
    const permissions = ACCESS_PROFILES[profileKey] as readonly PermissionKey[]

    return db.transaction(async (tx) => {
      let insertedCount = 0

      for (const permission of permissions) {
        const inserted = await tx
          .insert(accessGrant)
          .values({
            entityType: input.entityType,
            entityId: input.entityId,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            permission,
            allowed,
          })
          .onConflictDoNothing({
            target: [
              accessGrant.entityType,
              accessGrant.entityId,
              accessGrant.subjectType,
              accessGrant.subjectId,
              accessGrant.permission,
            ],
          })
          .returning({ id: accessGrant.id })

        if (inserted.length > 0) {
          insertedCount += inserted.length
        }
      }

      const rows = await tx
        .select({ id: accessGrant.id })
        .from(accessGrant)
        .where(
          and(
            eq(accessGrant.entityType, input.entityType),
            eq(accessGrant.entityId, input.entityId),
            eq(accessGrant.subjectType, input.subjectType),
            eq(accessGrant.subjectId, input.subjectId),
            inArray(accessGrant.permission, [...permissions]),
          ),
        )

      const ids = rows.map((row) => row.id)
      if (ids.length === 0) {
        return { ok: false, status: 409, error: 'Access grant conflict' } as const
      }

      return { ok: true, ids, created: insertedCount > 0 } as const
    })
  }

  const permission = input.permissionKey! as PermissionKey
  const inserted = await db
    .insert(accessGrant)
    .values({
      entityType: input.entityType,
      entityId: input.entityId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      permission,
      allowed,
    })
    .onConflictDoNothing({
      target: [
        accessGrant.entityType,
        accessGrant.entityId,
        accessGrant.subjectType,
        accessGrant.subjectId,
        accessGrant.permission,
      ],
    })
    .returning({ id: accessGrant.id })

  const id = inserted[0]?.id
  if (id) {
    return { ok: true, ids: [id], created: true }
  }

  const existing = await db
    .select({ id: accessGrant.id })
    .from(accessGrant)
    .where(
      and(
        eq(accessGrant.entityType, input.entityType),
        eq(accessGrant.entityId, input.entityId),
        eq(accessGrant.subjectType, input.subjectType),
        eq(accessGrant.subjectId, input.subjectId),
        eq(accessGrant.permission, permission),
      ),
    )
    .limit(1)

  const existingId = existing[0]?.id
  if (!existingId) {
    return { ok: false, status: 409, error: 'Access grant conflict' }
  }

  return { ok: true, ids: [existingId], created: false }
}
