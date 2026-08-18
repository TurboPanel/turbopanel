import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { location, mount, principal, storage } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { serializeLocation, serializeMount, serializeStorage } from './serialize.ts'
import {
  buildStorageUpdateFields,
  dockerVolumeMetadataWithId,
  isStorageContentTooLarge,
  mapStorageUniqueViolation,
  parseCreateStorageFields,
  parseLocationPatchFields,
  parseLocationRecord,
  parseMountPatchFields,
  parseMountRecord,
  parseOptionalStorageContent,
  parseStorageParent,
  principalProjectMismatch,
  resolveStorageParentContext,
  resolveStorageProjectId,
  scratchLocationNotMountable,
  SCRATCH_LOCATION_NOT_MOUNTABLE_ERROR,
  PARENT_FIELDS,
  type CreateLocationFields,
  type CreateMountFields,
  type StorageParentEntityKind,
  type StorageParentRef,
} from './routes-helpers.ts'

async function sealStorageContent(
  c: Context<AppEnv>,
  content: string,
): Promise<string | Response> {
  if (isStorageContentTooLarge(content)) {
    return c.json({ error: 'storage_content_too_large' }, 400)
  }

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
  }

  return await encryptSecret(dataEncryptionSecrets, content)
}

async function resolveSealedStorageContent(
  c: Context<AppEnv>,
  value: unknown,
): Promise<string | undefined | Response> {
  const contentResult = parseOptionalStorageContent(c, value)
  if (contentResult instanceof Response) return contentResult
  if (contentResult === undefined) return undefined
  return await sealStorageContent(c, contentResult)
}

const STORAGE_SELECT = {
  id: storage.id,
  organizationId: storage.organizationId,
  workspaceId: storage.workspaceId,
  projectId: storage.projectId,
  environmentId: storage.environmentId,
  serviceId: storage.serviceId,
  kind: storage.kind,
  name: storage.name,
  accessMode: storage.accessMode,
  retention: storage.retention,
  generation: storage.generation,
  principalId: storage.principalId,
  principalUsername: principal.username,
  metadata: storage.metadata,
  options: storage.options,
  createdAt: storage.createdAt,
  updatedAt: storage.updatedAt,
}

const LOCATION_SELECT = {
  id: location.id,
  storageId: location.storageId,
  serverId: location.serverId,
  credentialId: location.credentialId,
  provider: location.provider,
  role: location.role,
  state: location.state,
  path: location.path,
  endpoint: location.endpoint,
  generation: location.generation,
  metadata: location.metadata,
  options: location.options,
  createdAt: location.createdAt,
  updatedAt: location.updatedAt,
}

const MOUNT_SELECT = {
  id: mount.id,
  storageId: mount.storageId,
  serviceId: mount.serviceId,
  destinationPath: mount.destinationPath,
  subpath: mount.subpath,
  readOnly: mount.isReadOnly,
  metadata: mount.metadata,
  options: mount.options,
  createdAt: mount.createdAt,
  updatedAt: mount.updatedAt,
}

type StorageRow = typeof storage.$inferSelect
type StorageDb = NonNullable<ReturnType<typeof getDb>>

type StorageSessionContext = {
  db: StorageDb
  orgId: string
}

function uniqueViolationResponse(c: Context<AppEnv>, err: unknown): Response {
  const mapped = mapStorageUniqueViolation(err)
  if (mapped) return c.json({ error: mapped.error }, mapped.status)
  throw err
}

function parentInsertValues(parent: StorageParentRef): {
  workspaceId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
} {
  return {
    workspaceId: parent.column === 'workspaceId' ? parent.id : null,
    projectId: parent.column === 'projectId' ? parent.id : null,
    environmentId: parent.column === 'environmentId' ? parent.id : null,
    serviceId: parent.column === 'serviceId' ? parent.id : null,
  }
}

async function resolveStorageSessionContext(
  c: Context<AppEnv>,
): Promise<StorageSessionContext | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgId = await getOrgId(c, session.userId)
  if (orgId instanceof Response) return orgId

  return { db, orgId }
}

async function authorizeStorageMutation(
  c: Context<AppEnv>,
  existing: StorageRow | undefined,
  orgResult: string,
): Promise<Response | { parentId: string; entityKind: StorageParentEntityKind }> {
  if (existing?.organizationId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  const parent = resolveStorageParentContext(existing)
  if (!parent) return c.json({ error: 'Not found' }, 404)

  const denied = await assertCanManageOr403(c, parent.entityKind, parent.parentId)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, 'storage', existing.id)
  if (immutable) return immutable

  return parent
}

async function loadStorageChildren(db: StorageDb, storageIds: string[]) {
  const locationsByStorage = new Map<string, Array<{
    id: string
    storageId: string
    serverId: string | null
    credentialId: string | null
    provider: string
    role: string
    state: string
    path: string | null
    endpoint: string | null
    generation: number
    metadata: unknown
    options: unknown
    createdAt: string
    updatedAt: string
  }>>()
  const mountsByStorage = new Map<string, Array<{
    id: string
    storageId: string
    serviceId: string
    destinationPath: string
    subpath: string | null
    readOnly: boolean
    metadata: unknown
    options: unknown
    createdAt: string
    updatedAt: string
  }>>()
  if (storageIds.length === 0) {
    return { locationsByStorage, mountsByStorage }
  }

  const locRows = await db
    .select(LOCATION_SELECT)
    .from(location)
    .where(inArray(location.storageId, storageIds))
  const mountRows = await db
    .select(MOUNT_SELECT)
    .from(mount)
    .where(inArray(mount.storageId, storageIds))

  for (const row of locRows) {
    const list = locationsByStorage.get(row.storageId) ?? []
    list.push(row)
    locationsByStorage.set(row.storageId, list)
  }
  for (const row of mountRows) {
    const list = mountsByStorage.get(row.storageId) ?? []
    list.push(row)
    mountsByStorage.set(row.storageId, list)
  }
  return { locationsByStorage, mountsByStorage }
}

async function validatePrincipalRef(
  c: Context<AppEnv>,
  db: StorageDb,
  principalId: string | null | undefined,
  projectId: string | null,
): Promise<Response | null> {
  if (!principalId) return null
  const [principalRow] = await db
    .select({ projectId: principal.projectId })
    .from(principal)
    .where(eq(principal.id, principalId))
    .limit(1)
  if (!principalRow?.projectId) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (projectId && principalProjectMismatch(principalRow.projectId, projectId)) {
    return c.json({ error: 'principal_project_mismatch' }, 400)
  }
  return null
}

async function validateServerInOrg(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  serverId: string,
): Promise<Response | null> {
  const serverOrgId = await resolveEntityOrganizationId(db, 'server', serverId)
  if (!serverOrgId || serverOrgId !== orgId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return null
}

async function validateServiceInOrg(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  serviceId: string,
): Promise<Response | null> {
  const serviceOrgId = await resolveEntityOrganizationId(db, 'service', serviceId)
  if (!serviceOrgId || serviceOrgId !== orgId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return null
}

async function assertStorageMountable(
  c: Context<AppEnv>,
  db: StorageDb,
  storageId: string,
): Promise<Response | null> {
  const locRows = await db
    .select({ role: location.role })
    .from(location)
    .where(eq(location.storageId, storageId))
  if (locRows.length === 0) return null
  const hasNonScratch = locRows.some((row) => !scratchLocationNotMountable(row.role))
  if (!hasNonScratch) {
    return c.json({ error: SCRATCH_LOCATION_NOT_MOUNTABLE_ERROR }, 400)
  }
  return null
}

async function insertLocationRow(
  db: StorageDb,
  storageId: string,
  fields: CreateLocationFields,
) {
  const [inserted] = await db
    .insert(location)
    .values({
      storageId,
      serverId: fields.serverId,
      provider: fields.provider,
      role: fields.role,
      state: fields.state,
      path: fields.path,
      endpoint: fields.endpoint,
      metadata: fields.metadata,
      options: fields.options,
    })
    .returning({ id: location.id })
  return inserted.id
}

async function insertMountRow(
  db: StorageDb,
  storageId: string,
  fields: CreateMountFields,
) {
  const [inserted] = await db
    .insert(mount)
    .values({
      storageId,
      serviceId: fields.serviceId,
      destinationPath: fields.destinationPath,
      subpath: fields.subpath,
      isReadOnly: fields.readOnly,
    })
    .returning({ id: mount.id })
  return inserted.id
}

async function createStorageRecord(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const parent = parseStorageParent(c, body)
  if (parent instanceof Response) return parent

  const parentId = parent.id ?? orgId
  const denied = await assertCanCreateOr403(c, parent.entityKind, parentId)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, parent.entityKind, parentId)
  if (immutable) return immutable

  const fields = parseCreateStorageFields(c, body)
  if (fields instanceof Response) return fields

  const principalError = await validatePrincipalRef(
    c,
    db,
    fields.principalId,
    resolveStorageProjectId(parent),
  )
  if (principalError) return principalError

  if (fields.location) {
    const serverError = await validateServerInOrg(c, db, orgId, fields.location.serverId)
    if (serverError) return serverError
  }
  if (fields.mount) {
    const serviceError = await validateServiceInOrg(c, db, orgId, fields.mount.serviceId)
    if (serviceError) return serviceError
  }

  const sealedContent = await resolveSealedStorageContent(c, body.content)
  if (sealedContent instanceof Response) return sealedContent

  try {
    const storageId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(storage)
        .values({
          organizationId: orgId,
          ...parentInsertValues(parent),
          kind: fields.kind,
          name: fields.name,
          accessMode: fields.accessMode,
          retention: fields.retention,
          principalId: fields.principalId,
          metadata: fields.metadata,
          options: fields.options,
          contentEnvelope: sealedContent ?? null,
        })
        .returning({ id: storage.id })
      const id = inserted.id
      if (fields.kind === 'volume') {
        await tx
          .update(storage)
          .set({ metadata: dockerVolumeMetadataWithId(fields.metadata, id) })
          .where(eq(storage.id, id))
      }
      if (fields.location) {
        await insertLocationRow(tx as StorageDb, id, fields.location)
      }
      if (fields.mount) {
        await insertMountRow(tx as StorageDb, id, fields.mount)
      }
      return id
    })
    return c.json({ ok: true as const, id: storageId })
  } catch (err) {
    return uniqueViolationResponse(c, err)
  }
}

async function patchStorageRecord(
  c: Context<AppEnv>,
  db: StorageDb,
  id: string,
  existing: StorageRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const principalError = await validatePrincipalRef(
    c,
    db,
    typeof body.principalId === 'string' ? body.principalId : existing.principalId,
    existing.projectId,
  )
  if (principalError) return principalError

  const updateFields = buildStorageUpdateFields(c, body)
  if (updateFields instanceof Response) return updateFields

  const sealedContent = await resolveSealedStorageContent(c, body.content)
  if (sealedContent instanceof Response) return sealedContent
  if (sealedContent !== undefined) {
    updateFields.contentEnvelope = sealedContent
  }

  await db.update(storage).set(updateFields).where(eq(storage.id, id))
  return c.json({ ok: true as const })
}

async function requireStorageForNested(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  storageId: string,
  mode: 'read' | 'manage',
): Promise<Response | StorageRow> {
  const entityOrgId = await resolveEntityOrganizationId(db, 'storage', storageId)
  if (!entityOrgId || entityOrgId !== orgId) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied = mode === 'read'
    ? await assertCanReadOr403(c, 'storage', storageId)
    : await assertCanManageOr403(c, 'storage', storageId)
  if (denied) return denied

  if (mode === 'manage') {
    const immutable = await assertNotSystemOwnedOr403(c, 'storage', storageId)
    if (immutable) return immutable
  }

  const [row] = await db.select().from(storage).where(eq(storage.id, storageId)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return row
}

export function registerStorageRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for storage routes')
  }
  const secrets = opts.secrets

  router.use('/storage', createSessionMiddleware(secrets))
  router.use('/storage/:id', createSessionMiddleware(secrets))
  router.use('/storage/:id/locations', createSessionMiddleware(secrets))
  router.use('/storage/:id/locations/:locationId', createSessionMiddleware(secrets))
  router.use('/storage/:id/mounts', createSessionMiddleware(secrets))
  router.use('/storage/:id/mounts/:mountId', createSessionMiddleware(secrets))

  router.get('/storage', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const parentFilter = PARENT_FIELDS.find(({ bodyKey }) => c.req.query(bodyKey))
    if (parentFilter) {
      const parentId = c.req.query(parentFilter.bodyKey)
      if (!parentId) return c.json({ error: 'Invalid request' }, 400)

      const parentOrgId = await resolveEntityOrganizationId(
        db,
        parentFilter.entityKind,
        parentId,
      )
      if (!parentOrgId || parentOrgId !== orgResult) {
        return c.json({ error: 'Not found' }, 404)
      }

      const denied = await assertCanReadOr403(c, parentFilter.entityKind, parentId)
      if (denied) return denied

      const rows = await db
        .select(STORAGE_SELECT)
        .from(storage)
        .leftJoin(principal, eq(storage.principalId, principal.id))
        .where(and(
          eq(storage.organizationId, orgResult),
          eq(storage[parentFilter.column], parentId),
        ))
      const { locationsByStorage, mountsByStorage } = await loadStorageChildren(
        db,
        rows.map((row) => row.id),
      )
      return c.json({
        storage: rows.map((row) =>
          serializeStorage(
            row,
            locationsByStorage.get(row.id) ?? [],
            mountsByStorage.get(row.id) ?? [],
          ),
        ),
      })
    }

    const visibleIds = await listVisible(db, {
      kind: 'storage',
      userId: session.userId,
      organizationId: orgResult,
    })
    if (visibleIds.length === 0) {
      return c.json({ storage: [] })
    }

    const rows = await db
      .select(STORAGE_SELECT)
      .from(storage)
      .leftJoin(principal, eq(storage.principalId, principal.id))
      .where(inArray(storage.id, visibleIds))
      .orderBy(storage.createdAt)

    const { locationsByStorage, mountsByStorage } = await loadStorageChildren(
      db,
      rows.map((row) => row.id),
    )
    return c.json({
      storage: rows.map((row) =>
        serializeStorage(
          row,
          locationsByStorage.get(row.id) ?? [],
          mountsByStorage.get(row.id) ?? [],
        ),
      ),
    })
  })

  router.get('/storage/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'storage', id)
    if (!entityOrgId || entityOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'storage', id)
    if (denied) return denied

    const [row] = await db
      .select(STORAGE_SELECT)
      .from(storage)
      .leftJoin(principal, eq(storage.principalId, principal.id))
      .where(eq(storage.id, id))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const { locationsByStorage, mountsByStorage } = await loadStorageChildren(db, [id])
    return c.json({
      storage: serializeStorage(
        row,
        locationsByStorage.get(id) ?? [],
        mountsByStorage.get(id) ?? [],
      ),
    })
  })

  router.post('/storage', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    return createStorageRecord(c, ctx.db, ctx.orgId, body)
  })

  router.patch('/storage/:id', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx

    const id = c.req.param('id')
    const [existing] = await ctx.db.select().from(storage).where(eq(storage.id, id)).limit(1)

    const authorized = await authorizeStorageMutation(c, existing, ctx.orgId)
    if (authorized instanceof Response) return authorized

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    return patchStorageRecord(c, ctx.db, id, existing!, body)
  })

  router.delete('/storage/:id', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx

    const id = c.req.param('id')
    const [existing] = await ctx.db.select().from(storage).where(eq(storage.id, id)).limit(1)

    const authorized = await authorizeStorageMutation(c, existing, ctx.orgId)
    if (authorized instanceof Response) return authorized

    await ctx.db.delete(storage).where(eq(storage.id, id))
    return c.json({ ok: true as const })
  })

  router.get('/storage/:id/locations', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'read')
    if (row instanceof Response) return row

    const locRows = await ctx.db
      .select(LOCATION_SELECT)
      .from(location)
      .where(eq(location.storageId, storageId))
    let principalUsername: string | null = null
    if (row.principalId) {
      const [principalRow] = await ctx.db
        .select({ username: principal.username })
        .from(principal)
        .where(eq(principal.id, row.principalId))
        .limit(1)
      principalUsername = principalRow?.username ?? null
    }
    return c.json({
      locations: locRows.map((loc) =>
        serializeLocation(loc, storageId, principalUsername),
      ),
    })
  })

  router.post('/storage/:id/locations', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const fields = parseLocationRecord(c, body)
    if (fields instanceof Response) return fields

    const serverError = await validateServerInOrg(c, ctx.db, ctx.orgId, fields.serverId)
    if (serverError) return serverError

    try {
      const id = await insertLocationRow(ctx.db, storageId, fields)
      return c.json({ ok: true as const, id })
    } catch (err) {
      return uniqueViolationResponse(c, err)
    }
  })

  router.patch('/storage/:id/locations/:locationId', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const locationId = c.req.param('locationId')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const [existing] = await ctx.db
      .select({ id: location.id, storageId: location.storageId })
      .from(location)
      .where(and(eq(location.id, locationId), eq(location.storageId, storageId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const updateFields = parseLocationPatchFields(c, body)
    if (updateFields instanceof Response) return updateFields

    if (typeof updateFields.serverId === 'string') {
      const serverError = await validateServerInOrg(c, ctx.db, ctx.orgId, updateFields.serverId)
      if (serverError) return serverError
    }

    try {
      await ctx.db.update(location).set(updateFields).where(eq(location.id, locationId))
      return c.json({ ok: true as const })
    } catch (err) {
      return uniqueViolationResponse(c, err)
    }
  })

  router.delete('/storage/:id/locations/:locationId', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const locationId = c.req.param('locationId')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const deleted = await ctx.db
      .delete(location)
      .where(and(eq(location.id, locationId), eq(location.storageId, storageId)))
      .returning({ id: location.id })
    if (deleted.length === 0) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true as const })
  })

  router.get('/storage/:id/mounts', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'read')
    if (row instanceof Response) return row

    const mountRows = await ctx.db
      .select(MOUNT_SELECT)
      .from(mount)
      .where(eq(mount.storageId, storageId))
    return c.json({ mounts: mountRows.map(serializeMount) })
  })

  router.post('/storage/:id/mounts', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const fields = parseMountRecord(c, body)
    if (fields instanceof Response) return fields

    const serviceError = await validateServiceInOrg(c, ctx.db, ctx.orgId, fields.serviceId)
    if (serviceError) return serviceError
    const mountable = await assertStorageMountable(c, ctx.db, storageId)
    if (mountable) return mountable

    try {
      const id = await insertMountRow(ctx.db, storageId, fields)
      return c.json({ ok: true as const, id })
    } catch (err) {
      return uniqueViolationResponse(c, err)
    }
  })

  router.patch('/storage/:id/mounts/:mountId', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const mountId = c.req.param('mountId')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const [existing] = await ctx.db
      .select({ id: mount.id })
      .from(mount)
      .where(and(eq(mount.id, mountId), eq(mount.storageId, storageId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const updateFields = parseMountPatchFields(c, body)
    if (updateFields instanceof Response) return updateFields

    try {
      await ctx.db.update(mount).set(updateFields).where(eq(mount.id, mountId))
      return c.json({ ok: true as const })
    } catch (err) {
      return uniqueViolationResponse(c, err)
    }
  })

  router.delete('/storage/:id/mounts/:mountId', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const mountId = c.req.param('mountId')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const deleted = await ctx.db
      .delete(mount)
      .where(and(eq(mount.id, mountId), eq(mount.storageId, storageId)))
      .returning({ id: mount.id })
    if (deleted.length === 0) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true as const })
  })
}
