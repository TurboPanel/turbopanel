import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db.ts'
import { principal, storage } from '../../lib/db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { serializeStorage } from './serialize.ts'
import {
  buildStorageUpdateFields,
  isStorageContentTooLarge,
  mountKindRequiresDestination,
  PARENT_FIELDS,
  parseCreateStorageFields,
  parseOptionalStorageContent,
  parseStorageParent,
  resolvePatchStorageRefs,
  resolveStorageParentContext,
  resolveStorageProjectId,
  type StorageParentEntityKind,
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

  return encryptSecret(dataEncryptionSecrets, content)
}

async function resolveSealedStorageContent(
  c: Context<AppEnv>,
  value: unknown,
): Promise<string | undefined | Response> {
  const contentResult = parseOptionalStorageContent(c, value)
  if (contentResult instanceof Response) return contentResult
  if (contentResult === undefined) return undefined
  return sealStorageContent(c, contentResult)
}

const STORAGE_SELECT = {
  id: storage.id,
  organizationId: storage.organizationId,
  projectId: storage.projectId,
  environmentId: storage.environmentId,
  serviceId: storage.serviceId,
  serverId: storage.serverId,
  kind: storage.kind,
  name: storage.name,
  sourcePath: storage.sourcePath,
  destinationPath: storage.destinationPath,
  principalId: storage.principalId,
  principalUsername: principal.username,
  metadata: storage.metadata,
  options: storage.options,
  createdAt: storage.createdAt,
  updatedAt: storage.updatedAt,
}

type StorageRow = typeof storage.$inferSelect
type StorageDb = NonNullable<ReturnType<typeof getDb>>

type StorageSessionContext = {
  db: StorageDb
  orgId: string
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

async function validateStorageReferences(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  orgResult: string,
  params: {
    serverId: string
    principalId?: string | null
    kind: StorageKind
    destinationPath?: string | null
    projectId?: string | null
  },
): Promise<Response | null> {
  const serverOrgId = await resolveEntityOrganizationId(db, 'server', params.serverId)
  if (!serverOrgId || serverOrgId !== orgResult) {
    return c.json({ error: 'Not found' }, 404)
  }

  if (mountKindRequiresDestination(params.kind, params.destinationPath)) {
    return c.json({ error: 'destinationPath is required for mount kinds' }, 400)
  }

  if (params.principalId) {
    const [principalRow] = await db
      .select({ projectId: principal.projectId })
      .from(principal)
      .where(eq(principal.id, params.principalId))
      .limit(1)
    if (!principalRow?.projectId) {
      return c.json({ error: 'Not found' }, 404)
    }
    if (params.projectId && principalRow.projectId !== params.projectId) {
      return c.json({ error: 'principal_project_mismatch' }, 400)
    }
  }

  return null
}

async function createStorageRecord(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const parent = parseStorageParent(c, body)
  if (parent instanceof Response) return parent

  const denied = await assertCanCreateOr403(c, parent.entityKind, parent.id)
  if (denied) return denied

  const immutable = await assertNotSystemOwnedOr403(c, parent.entityKind, parent.id)
  if (immutable) return immutable

  const fields = parseCreateStorageFields(c, body)
  if (fields instanceof Response) return fields

  const validationError = await validateStorageReferences(c, db, orgId, {
    serverId: fields.serverId,
    principalId: fields.principalId,
    kind: fields.kind,
    destinationPath: fields.destinationPath,
    projectId: resolveStorageProjectId(parent),
  })
  if (validationError) return validationError

  const sealedContent = await resolveSealedStorageContent(c, body.content)
  if (sealedContent instanceof Response) return sealedContent

  const [inserted] = await db.insert(storage).values({
    organizationId: orgId,
    projectId: null,
    environmentId: null,
    serviceId: null,
    serverId: fields.serverId,
    kind: fields.kind,
    name: fields.name,
    sourcePath: fields.sourcePath,
    destinationPath: fields.destinationPath,
    principalId: fields.principalId,
    metadata: fields.metadata,
    options: fields.options,
    contentEnvelope: sealedContent ?? null,
    [parent.column]: parent.id,
  }).returning({ id: storage.id })

  // New docker_volume rows pin their on-host name to the storage UUID.
  if (fields.kind === 'docker_volume') {
    const existingMeta =
      typeof fields.metadata === 'object' &&
      fields.metadata !== null &&
      !Array.isArray(fields.metadata)
        ? (fields.metadata as Record<string, unknown>)
        : {}
    await db
      .update(storage)
      .set({
        metadata: {
          ...existingMeta,
          dockerVolumeName: inserted.id,
        },
      })
      .where(eq(storage.id, inserted.id))
  }

  return c.json({ ok: true as const, id: inserted.id })
}

async function patchStorageRecord(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  id: string,
  existing: StorageRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const next = resolvePatchStorageRefs(body, existing)
  const validationError = await validateStorageReferences(c, db, orgId, {
    serverId: next.serverId,
    principalId: next.principalId,
    kind: next.kind,
    destinationPath: next.destinationPath,
    projectId: existing.projectId,
  })
  if (validationError) return validationError

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

export function registerStorageRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  router.use('/storage', createSessionMiddleware(opts.secrets))
  router.use('/storage/:id', createSessionMiddleware(opts.secrets))

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
      return c.json({ storage: rows.map(serializeStorage) })
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

    return c.json({ storage: rows.map(serializeStorage) })
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

    return c.json({ storage: serializeStorage(row) })
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

    return patchStorageRecord(c, ctx.db, ctx.orgId, id, existing!, body)
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
}
