import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  grant,
  container,
  environment,
  hosting,
  managed,
  organization,
  principal,
  project,
  storage,
  variable,
  workspace,
  server,
  service,
  team,
  tls,
  user,
  network,
  datacenter,
  ip,
  vpn,
  peer,
} from '../../lib/db/schema.ts'
import {
  isGrantEntityType,
  isPermissionKey,
  isSystemPermissionKey,
  type PermissionKey,
} from './catalog.ts'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CreateAccessGrantInput = {
  actorType: 'user' | 'team' | 'organization'
  actorId: string
  entityType: string
  entityId: string
  permissionKey: string
}

export type CreateAccessGrantResult =
  | { ok: true; ids: string[]; created: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string }

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

const ACCESS_GRANT_ENTITY_TYPES = ['organization', 'team'] as const

export function isAccessGrantEntityType(
  entityType: string,
): entityType is (typeof ACCESS_GRANT_ENTITY_TYPES)[number] {
  return entityType === 'organization' || entityType === 'team'
}

export function validatePermissionEntityCompatibility(
  permissionKey: PermissionKey,
  entityType: string,
): { ok: true } | { ok: false; error: string } {
  if (
    (permissionKey === 'organization:own' || permissionKey === 'organization:manage') &&
    entityType !== 'organization'
  ) {
    return {
      ok: false,
      error: `${permissionKey} may only be granted on organization entities`,
    }
  }

  if (isSystemPermissionKey(permissionKey) && entityType !== 'organization') {
    return {
      ok: false,
      error: `${permissionKey} may only be granted on organization entities`,
    }
  }

  if (
    (permissionKey === 'team:own' || permissionKey === 'team:manage') &&
    entityType !== 'team'
  ) {
    return {
      ok: false,
      error: `${permissionKey} may only be granted on team entities`,
    }
  }

  return { ok: true }
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
    case 'team': {
      const rows = await db
        .select({ id: team.id })
        .from(team)
        .where(eq(team.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'workspace': {
      const rows = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.id, entityId))
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
    case 'container': {
      const rows = await db
        .select({ id: container.id })
        .from(container)
        .where(eq(container.id, entityId))
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
    case 'tls': {
      const rows = await db
        .select({ id: tls.id })
        .from(tls)
        .where(eq(tls.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'managed': {
      const rows = await db
        .select({ id: managed.id })
        .from(managed)
        .where(eq(managed.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'variable': {
      const rows = await db
        .select({ id: variable.id })
        .from(variable)
        .where(eq(variable.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'principal': {
      const rows = await db
        .select({ id: principal.id })
        .from(principal)
        .where(eq(principal.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'storage': {
      const rows = await db
        .select({ id: storage.id })
        .from(storage)
        .where(eq(storage.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'network': {
      const rows = await db
        .select({ id: network.id })
        .from(network)
        .where(eq(network.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'datacenter': {
      const rows = await db
        .select({ id: datacenter.id })
        .from(datacenter)
        .where(eq(datacenter.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'ip': {
      const rows = await db
        .select({ id: ip.id })
        .from(ip)
        .where(eq(ip.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'vpn': {
      const rows = await db
        .select({ id: vpn.id })
        .from(vpn)
        .where(eq(vpn.id, entityId))
        .limit(1)
      return rows.length > 0
    }
    case 'peer': {
      const rows = await db
        .select({ id: peer.id })
        .from(peer)
        .where(eq(peer.id, entityId))
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
  if (!isGrantEntityType(entityType)) {
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
    case 'team': {
      const rows = await db
        .select({ organizationId: team.organizationId })
        .from(team)
        .where(eq(team.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'workspace': {
      const rows = await db
        .select({ organizationId: workspace.organizationId })
        .from(workspace)
        .where(eq(workspace.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'environment': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id
        FROM environment e
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE e.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    case 'project': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id
        FROM project p
        JOIN workspace w ON w.id = p.workspace_id
        WHERE p.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    case 'service': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id
        FROM service s
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE s.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    case 'hosting': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id AS organization_id
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE h.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    case 'container': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id AS organization_id
        FROM container c
        JOIN service s ON s.id = c.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE c.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    case 'server': {
      const rows = await db
        .select({ organizationId: server.organizationId })
        .from(server)
        .where(eq(server.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'tls': {
      const rows = await db
        .select({ organizationId: tls.organizationId })
        .from(tls)
        .where(eq(tls.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'managed': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id
        FROM managed m
        JOIN environment e ON e.id = m.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE m.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    case 'variable': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT CASE
          WHEN v.organization_id IS NOT NULL THEN v.organization_id
          WHEN v.workspace_id IS NOT NULL THEN w.organization_id
          WHEN v.project_id IS NOT NULL THEN pw.organization_id
          WHEN v.environment_id IS NOT NULL THEN ew.organization_id
          WHEN v.service_id IS NOT NULL THEN sw.organization_id
          WHEN v.hosting_id IS NOT NULL THEN hw.organization_id
          WHEN v.server_id IS NOT NULL THEN sv.organization_id
        END AS organization_id
        FROM variable v
        LEFT JOIN workspace w ON w.id = v.workspace_id
        LEFT JOIN project p ON p.id = v.project_id
        LEFT JOIN workspace pw ON pw.id = p.workspace_id
        LEFT JOIN environment e ON e.id = v.environment_id
        LEFT JOIN project ep ON ep.id = e.project_id
        LEFT JOIN workspace ew ON ew.id = ep.workspace_id
        LEFT JOIN service s ON s.id = v.service_id
        LEFT JOIN environment se ON se.id = s.environment_id
        LEFT JOIN project sp ON sp.id = se.project_id
        LEFT JOIN workspace sw ON sw.id = sp.workspace_id
        LEFT JOIN hosting h ON h.id = v.hosting_id
        LEFT JOIN service hs ON hs.id = h.service_id
        LEFT JOIN environment he ON he.id = hs.environment_id
        LEFT JOIN project hp ON hp.id = he.project_id
        LEFT JOIN workspace hw ON hw.id = hp.workspace_id
        LEFT JOIN server sv ON sv.id = v.server_id
        WHERE v.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    case 'principal': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id AS organization_id
        FROM principal p
        LEFT JOIN project pr ON pr.id = p.project_id
        LEFT JOIN workspace w ON w.id = pr.workspace_id
        WHERE p.id = ${entityId}::uuid
          AND p.project_id IS NOT NULL
        LIMIT 1
      `)
      if (rows[0]?.organization_id) return rows[0].organization_id

      const assignmentRows = await db.execute<{ organization_id: string }>(sql`
        SELECT w.organization_id AS organization_id
        FROM principal p
        JOIN assignment a ON a.principal_id = p.id
        JOIN service s ON s.id = a.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project pr ON pr.id = e.project_id
        JOIN workspace w ON w.id = pr.workspace_id
        WHERE p.id = ${entityId}::uuid
        LIMIT 1
      `)
      return assignmentRows[0]?.organization_id ?? null
    }
    case 'storage': {
      const rows = await db
        .select({ organizationId: storage.organizationId })
        .from(storage)
        .where(eq(storage.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'network': {
      const rows = await db
        .select({ organizationId: network.organizationId })
        .from(network)
        .where(eq(network.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'datacenter': {
      const rows = await db
        .select({ organizationId: datacenter.organizationId })
        .from(datacenter)
        .where(eq(datacenter.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'ip': {
      const rows = await db
        .select({ organizationId: ip.organizationId })
        .from(ip)
        .where(eq(ip.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'vpn': {
      const rows = await db
        .select({ organizationId: vpn.organizationId })
        .from(vpn)
        .where(eq(vpn.id, entityId))
        .limit(1)
      return rows[0]?.organizationId ?? null
    }
    case 'peer': {
      const rows = await db.execute<{ organization_id: string }>(sql`
        SELECT v.organization_id
        FROM peer p
        JOIN vpn v ON v.id = p.vpn_id
        WHERE p.id = ${entityId}::uuid
        LIMIT 1
      `)
      return rows[0]?.organization_id ?? null
    }
    default:
      return null
  }
}

async function resolveActor(
  db: Db,
  actorType: CreateAccessGrantInput['actorType'],
  actorId: string,
  entityOrganizationId: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 404; error: string }> {
  if (actorType === 'user') {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, actorId))
      .limit(1)
    if (rows.length === 0) {
      return { ok: false, status: 404, error: 'User not found' }
    }
    return { ok: true }
  }

  if (actorType === 'team') {
    const rows = await db
      .select({ id: team.id, organizationId: team.organizationId })
      .from(team)
      .where(eq(team.id, actorId))
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
    .where(eq(organization.id, actorId))
    .limit(1)
  if (rows.length === 0) {
    return { ok: false, status: 404, error: 'Organization not found' }
  }
  if (actorId !== entityOrganizationId) {
    return {
      ok: false,
      status: 400,
      error: 'Organization actor must match the entity organization',
    }
  }
  return { ok: true }
}

export async function createAccessGrant(
  db: Db,
  input: CreateAccessGrantInput,
): Promise<CreateAccessGrantResult> {
  if (!isAccessGrantEntityType(input.entityType)) {
    return {
      ok: false,
      status: 400,
      error: 'Access grants may only target organization or team entities',
    }
  }

  const grantEntityType = input.entityType

  if (
    input.actorType !== 'user' &&
    input.actorType !== 'team' &&
    input.actorType !== 'organization'
  ) {
    return { ok: false, status: 400, error: 'Invalid request' }
  }

  if (!isUuid(input.entityId) || !isUuid(input.actorId)) {
    return { ok: false, status: 400, error: 'Invalid request' }
  }

  if (
    typeof input.permissionKey !== 'string' ||
    input.permissionKey.length === 0 ||
    !isPermissionKey(input.permissionKey)
  ) {
    return { ok: false, status: 400, error: 'Invalid permission key' }
  }

  const permission = input.permissionKey as PermissionKey
  const permissionCompat = validatePermissionEntityCompatibility(
    permission,
    input.entityType,
  )
  if (!permissionCompat.ok) {
    return { ok: false, status: 400, error: permissionCompat.error }
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

  const actorResult = await resolveActor(
    db,
    input.actorType,
    input.actorId,
    entityOrganizationId,
  )
  if (!actorResult.ok) {
    return actorResult
  }

  const inserted = await db
    .insert(grant)
    .values({
      entityType: grantEntityType,
      entityId: input.entityId,
      actorType: input.actorType,
      actorId: input.actorId,
      permission,
    })
    .onConflictDoNothing({
      target: [
        grant.entityType,
        grant.entityId,
        grant.actorType,
        grant.actorId,
        grant.permission,
      ],
    })
    .returning({ id: grant.id })

  const id = inserted[0]?.id
  if (id) {
    return { ok: true, ids: [id], created: true }
  }

  const existing = await db
    .select({ id: grant.id })
    .from(grant)
    .where(
      and(
        eq(grant.entityType, grantEntityType),
        eq(grant.entityId, input.entityId),
        eq(grant.actorType, input.actorType),
        eq(grant.actorId, input.actorId),
        eq(grant.permission, permission),
      ),
    )
    .limit(1)

  const existingId = existing[0]?.id
  if (!existingId) {
    return { ok: false, status: 409, error: 'Access grant conflict' }
  }

  return { ok: true, ids: [existingId], created: false }
}
