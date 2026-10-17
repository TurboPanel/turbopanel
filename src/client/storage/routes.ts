import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import { and, eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb } from '../../db/connection.ts'
import {
  environment,
  service,
  storageCopy,
  mount,
  principal,
  secret,
  storage,
} from '../../db/schema.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  assertNotSystemOwnedOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { serializeCopy, serializeMount, serializeStorage } from './serialize.ts'
import {
  captureCopyBackupHosts,
  reconcileBackupsAfterCopyChange,
} from '../../features/backups/reconcile.ts'
import {
  buildStorageUpdateFields,
  dockerVolumeMetadataWithId,
  isStorageContentTooLarge,
  mapStorageUniqueViolation,
  parseCreateStorageFields,
  parseCopyPatchFields,
  parseCopyRecord,
  parseMountPatchFields,
  parseMountRecord,
  parseOptionalStorageContent,
  parseStorageParent,
  principalProjectMismatch,
  resolveStorageParentContext,
  resolveStorageProjectId,
  scratchCopyNotMountable,
  SCRATCH_COPY_NOT_MOUNTABLE_ERROR,
  PARENT_FIELDS,
  type CreateCopyFields,
  type CreateMountFields,
  type StorageParentEntityKind,
  type StorageParentRef,
} from './routes-helpers.ts'
import { copyOptionsError, copyPathWriteError } from '../../features/backups/copy-targets.ts'
import {
  FolderPlanError,
  markAssetFoldersRemoving,
  markVolumeFolderRemoving,
  planVolumeFolder,
  readDirectoryNameMode,
  scopeFor,
  settleFolderName,
} from '../../features/folders/allocate.ts'
import {
  type FolderOptions,
  hasFolderOptions,
  parseFolderOptions,
} from '../../features/folders/options.ts'
import {
  lockEnvironmentRow,
  SCOPE_LOCKED_ERROR,
  storageHasFolder,
} from '../../features/folders/records.ts'
import { inUseBody, listUsesOfAssets } from '../../features/folders/shares.ts'

async function sealStorageContent(c: Context<AppEnv>, content: string): Promise<string | Response> {
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
  value: unknown
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
  // Applied login — storage paths live under /srv/users/<applied>/volumes.
  principalUsername: principal.appliedUsername,
  slug: storage.slug,
  isCommon: storage.isCommon,
  metadata: storage.metadata,
  options: storage.options,
  createdAt: storage.createdAt,
  updatedAt: storage.updatedAt,
}

const COPY_SELECT = {
  id: storageCopy.id,
  storageId: storageCopy.storageId,
  serverId: storageCopy.serverId,
  secretId: storageCopy.secretId,
  provider: storageCopy.provider,
  role: storageCopy.role,
  state: storageCopy.state,
  path: storageCopy.path,
  endpoint: storageCopy.endpoint,
  generation: storageCopy.generation,
  metadata: storageCopy.metadata,
  options: storageCopy.options,
  createdAt: storageCopy.createdAt,
  updatedAt: storageCopy.updatedAt,
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

export async function resolveStorageSessionContext(
  c: Context<AppEnv>
): Promise<StorageSessionContext | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgId = await getOrgId(c, session.userId)
  if (orgId instanceof Response) return orgId

  return { db, orgId }
}

/**
 * After a write to storage copies: push a fresh backup set to every host
 * captured before it, and to the new host of any copy in `copyIds` that moved.
 * Best-effort, never throws — the write already succeeded.
 */
async function repushCopyBackups(
  c: Context<AppEnv>,
  db: StorageDb,
  copyIds: readonly string[],
  previousServerIds: readonly string[]
): Promise<void> {
  const session = c.get('session')
  await reconcileBackupsAfterCopyChange(db, c.get('commandQueue'), {
    copyIds,
    previousServerIds,
    actor: { actorType: 'user', actorId: session?.userId ?? 'unknown' },
  })
}

async function authorizeStorageMutation(
  c: Context<AppEnv>,
  existing: StorageRow | undefined,
  orgResult: string
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
  const copiesByStorage = new Map<
    string,
    Array<{
      id: string
      storageId: string
      serverId: string | null
      secretId: string | null
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
    }>
  >()
  const mountsByStorage = new Map<
    string,
    Array<{
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
    }>
  >()
  if (storageIds.length === 0) {
    return { copiesByStorage, mountsByStorage }
  }

  const copyRows = await db
    .select(COPY_SELECT)
    .from(storageCopy)
    .where(inArray(storageCopy.storageId, storageIds))
  const mountRows = await db
    .select(MOUNT_SELECT)
    .from(mount)
    .where(inArray(mount.storageId, storageIds))

  for (const row of copyRows) {
    const list = copiesByStorage.get(row.storageId) ?? []
    list.push(row)
    copiesByStorage.set(row.storageId, list)
  }
  for (const row of mountRows) {
    const list = mountsByStorage.get(row.storageId) ?? []
    list.push(row)
    mountsByStorage.set(row.storageId, list)
  }
  return { copiesByStorage, mountsByStorage }
}

async function validatePrincipalRef(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  principalId: string | null | undefined,
  projectId: string | null
): Promise<Response | null> {
  if (!principalId) return null
  const [principalRow] = await db
    .select({ projectId: principal.projectId })
    .from(principal)
    // Another organization's principal reads as missing: its credentials would
    // otherwise ship with this storage at deploy.
    .where(and(eq(principal.id, principalId), eq(principal.organizationId, orgId)))
    .limit(1)
  // A principal whose project was deleted (`project_id` NULL) is still the
  // organization's own and keeps serving the storage it owns; only a storage
  // scoped to a project cannot name it.
  if (!principalRow) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (projectId && principalProjectMismatch(principalRow.projectId ?? '', projectId)) {
    return c.json({ error: 'principal_project_mismatch' }, 400)
  }
  return null
}

/** A copy's server and credential must both be the organization's own; anything else is 404. */
async function validateCopyRefsInOrg(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  refs: { serverId?: unknown; secretId?: unknown }
): Promise<Response | null> {
  if (
    typeof refs.serverId === 'string' &&
    (await resolveEntityOrganizationId(db, 'server', refs.serverId)) !== orgId
  ) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (typeof refs.secretId === 'string') {
    const [owned] = await db
      .select({ id: secret.id })
      .from(secret)
      .where(and(eq(secret.id, refs.secretId), eq(secret.organizationId, orgId)))
      .limit(1)
    if (!owned) return c.json({ error: 'Not found' }, 404)
  }
  return null
}

/**
 * A copy may only point at the storage's own site owner's directories and the
 * storage's own Docker volume: its path must sit inside that owner's volumes
 * directory, and it cannot name an external volume (deploy records those from
 * the project's compose file, and the host re-checks them). Anything else is 400.
 */
async function validateCopyOwnership(
  c: Context<AppEnv>,
  db: StorageDb,
  principalId: string | null,
  copy: { path?: unknown; options?: unknown }
): Promise<Response | null> {
  const optionsError = copyOptionsError(copy.options)
  if (optionsError) return c.json({ error: optionsError }, 400)
  if (typeof copy.path !== 'string' || copy.path.length === 0) return null
  let username: string | null = null
  if (principalId) {
    const [row] = await db
      .select({ username: principal.appliedUsername })
      .from(principal)
      .where(eq(principal.id, principalId))
      .limit(1)
    username = row?.username ?? null
  }
  const pathError = copyPathWriteError(username, copy.path)
  return pathError ? c.json({ error: pathError }, 400) : null
}

async function validateServiceInOrg(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  serviceId: string
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
  storageId: string
): Promise<Response | null> {
  const copyRows = await db
    .select({ role: storageCopy.role })
    .from(storageCopy)
    .where(eq(storageCopy.storageId, storageId))
  if (copyRows.length === 0) return null
  const hasNonScratch = copyRows.some((row) => !scratchCopyNotMountable(row.role))
  if (!hasNonScratch) {
    return c.json({ error: SCRATCH_COPY_NOT_MOUNTABLE_ERROR }, 400)
  }
  return null
}

async function insertCopyRow(db: StorageDb, storageId: string, fields: CreateCopyFields) {
  const [inserted] = await db
    .insert(storageCopy)
    .values({
      storageId,
      serverId: fields.serverId,
      secretId: fields.secretId,
      provider: fields.provider,
      role: fields.role,
      state: fields.state,
      path: fields.path,
      endpoint: fields.endpoint,
      metadata: fields.metadata,
      options: fields.options,
    })
    .returning({ id: storageCopy.id })
  return inserted.id
}

async function insertMountRow(db: StorageDb, storageId: string, fields: CreateMountFields) {
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

/** The environment a volume sits in: its own, or its service's; null for any other parent. */
async function resolveVolumeEnvironmentId(
  db: StorageDb,
  volume: { environmentId: string | null; serviceId: string | null }
): Promise<string | null> {
  if (volume.environmentId !== null) return volume.environmentId
  if (volume.serviceId === null) return null
  const [row] = await db
    .select({ environmentId: service.environmentId })
    .from(service)
    .where(eq(service.id, volume.serviceId))
    .limit(1)
  return row?.environmentId ?? null
}

/** The environment a new volume sits in, from the parent named in the request. */
function resolveParentEnvironmentId(db: StorageDb, parent: StorageParentRef) {
  return resolveVolumeEnvironmentId(db, {
    environmentId: parent.column === 'environmentId' ? parent.id : null,
    serviceId: parent.column === 'serviceId' ? parent.id : null,
  })
}

/**
 * Settle the folder name of a new volume: the organization setting, the typed
 * name (never suffixed) or the default from the display name, and the clash
 * check against the site owner's other volumes in the same scope.
 */
async function nameVolumeFolder(
  tx: StorageDb,
  input: {
    storageId: string
    organizationId: string
    principalId: string | null
    name: string
    isCommon: boolean
    environmentId: string | null
    options: { slug?: string; directoryName?: 'slug' | 'uuid' }
  }
): Promise<void> {
  let environmentName: string | null = null
  if (!input.isCommon && input.environmentId !== null) {
    const [row] = await tx
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.id, input.environmentId))
      .limit(1)
    environmentName = row?.name ?? null
  }
  const scope = scopeFor(input.isCommon, environmentName)
  const settled = await settleFolderName(tx, {
    mode: await readDirectoryNameMode(tx, input.organizationId),
    kind: 'volume',
    assetId: input.storageId,
    principalId: input.principalId,
    scope,
    request: {
      ...(input.options.slug === undefined ? {} : { typed: input.options.slug }),
      ...(input.options.directoryName === undefined ? {} : { choice: input.options.directoryName }),
    },
    label: input.name,
  })
  await tx.update(storage).set({ slug: settled.slug }).where(eq(storage.id, input.storageId))
}

type CreateFolderPlan = {
  hasFolder: boolean
  isCommon: boolean
  parentEnvironmentId: string | null
  options: FolderOptions
}

/** What a create body asks of the folder: its fields, whether the kind has a folder, and the scope. */
async function resolveCreateFolderPlan(
  c: Context<AppEnv>,
  db: StorageDb,
  parent: StorageParentRef,
  kind: string,
  body: Record<string, unknown>
): Promise<CreateFolderPlan | Response> {
  const folderOptions = parseFolderOptions(body)
  if (!folderOptions.ok) return c.json({ error: 'Invalid request' }, 400)
  const hasFolder = kind === 'volume' || kind === 'directory'
  if (!hasFolder && hasFolderOptions(folderOptions.options)) {
    return c.json(
      {
        error: 'folder_options_not_supported',
        message:
          'Only volumes and directories have a folder. Remove slug, directoryName and common.',
      },
      400
    )
  }
  // A volume that belongs to no environment (organization, workspace or project) is shared.
  const parentEnvironmentId = await resolveParentEnvironmentId(db, parent)
  return {
    hasFolder,
    parentEnvironmentId,
    options: folderOptions.options,
    isCommon: hasFolder && (parentEnvironmentId === null || folderOptions.options.common === true),
  }
}

/** The folder name, copy and mount of a volume that was just inserted. */
async function addCreatedChildren(
  tx: StorageDb,
  id: string,
  orgId: string,
  fields: Exclude<ReturnType<typeof parseCreateStorageFields>, Response>,
  plan: CreateFolderPlan
): Promise<void> {
  if (plan.hasFolder) {
    await nameVolumeFolder(tx, {
      storageId: id,
      organizationId: orgId,
      principalId: fields.principalId,
      name: fields.name,
      isCommon: plan.isCommon,
      environmentId: plan.parentEnvironmentId,
      options: plan.options,
    })
  }
  if (fields.copy) {
    await insertCopyRow(tx, id, fields.copy)
    if (plan.hasFolder && fields.copy.provider === 'path') {
      await planVolumeFolder(tx, { storageId: id, serverId: fields.copy.serverId })
    }
  }
  if (fields.mount) await insertMountRow(tx, id, fields.mount)
}

/** The copy and mount named in a create body must belong to the organization and the site owner. */
async function validateCreateChildren(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  fields: Exclude<ReturnType<typeof parseCreateStorageFields>, Response>
): Promise<Response | null> {
  if (fields.copy) {
    const copyRefError = await validateCopyRefsInOrg(c, db, orgId, fields.copy)
    if (copyRefError) return copyRefError
    const ownershipError = await validateCopyOwnership(c, db, fields.principalId, fields.copy)
    if (ownershipError) return ownershipError
  }
  if (fields.mount) return await validateServiceInOrg(c, db, orgId, fields.mount.serviceId)
  return null
}

async function createStorageRecord(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  body: Record<string, unknown>
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
    orgId,
    fields.principalId,
    resolveStorageProjectId(parent)
  )
  if (principalError) return principalError

  const childError = await validateCreateChildren(c, db, orgId, fields)
  if (childError) return childError

  const sealedContent = await resolveSealedStorageContent(c, body.content)
  if (sealedContent instanceof Response) return sealedContent

  const plan = await resolveCreateFolderPlan(c, db, parent, fields.kind, body)
  if (plan instanceof Response) return plan

  try {
    const storageId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(storage)
        .values({
          organizationId: orgId,
          ...parentInsertValues(parent),
          isCommon: plan.isCommon,
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
      await addCreatedChildren(tx as StorageDb, id, orgId, fields, plan)
      return id
    })
    return c.json({ ok: true as const, id: storageId })
  } catch (err) {
    if (err instanceof FolderPlanError) return c.json(err.body(), err.status)
    return uniqueViolationResponse(c, err)
  }
}

/**
 * The folder is chosen at creation: `common` never changes, the folder name
 * and the site owner stop changing once a folder exists for the volume.
 */
async function refuseLockedFolderPatch(
  c: Context<AppEnv>,
  db: StorageDb,
  existing: StorageRow,
  body: Record<string, unknown>
): Promise<Response | null> {
  if ('common' in body && body.common !== existing.isCommon) {
    return c.json(
      {
        error: SCOPE_LOCKED_ERROR,
        message:
          'Whether a volume is shared by every environment is chosen when it is created and cannot change.',
      },
      409
    )
  }
  const ownerChange =
    'principalId' in body && (body.principalId ?? null) !== (existing.principalId ?? null)
  if ('slug' in body && typeof body.slug !== 'string')
    return c.json({ error: 'Invalid request' }, 400)
  if ('slug' in body && existing.kind !== 'volume' && existing.kind !== 'directory') {
    return c.json(
      {
        error: 'folder_options_not_supported',
        message: 'Only volumes and directories have a folder name.',
      },
      400
    )
  }
  const slugChange = 'slug' in body && body.slug !== existing.slug
  if (!ownerChange && !slugChange) return null
  if (!(await storageHasFolder(db, existing.id))) return null
  return c.json(
    {
      error: 'storage_slug_locked',
      message:
        'This volume already has a folder on a server, so its folder name and site owner can no longer change.',
    },
    409
  )
}

async function patchStorageRecord(
  c: Context<AppEnv>,
  db: StorageDb,
  id: string,
  existing: StorageRow,
  body: Record<string, unknown>
): Promise<Response> {
  const principalError = await validatePrincipalRef(
    c,
    db,
    existing.organizationId,
    typeof body.principalId === 'string' ? body.principalId : existing.principalId,
    existing.projectId
  )
  if (principalError) return principalError

  const updateFields = buildStorageUpdateFields(c, body)
  if (updateFields instanceof Response) return updateFields
  const pinned = (updateFields.metadata as Record<string, unknown> | undefined)?.dockerVolumeName
  if (pinned !== undefined && pinned !== id) {
    return c.json({ error: 'A storage can only name its own Docker volume' }, 400)
  }

  const sealedContent = await resolveSealedStorageContent(c, body.content)
  if (sealedContent instanceof Response) return sealedContent
  if (sealedContent !== undefined) {
    updateFields.contentEnvelope = sealedContent
  }

  try {
    const refused = await db.transaction(async (tx) => {
      // The folder rows are read under the environment row lock a deploy plans under, so a
      // folder cannot appear between the check and the write.
      const environmentId = await resolveVolumeEnvironmentId(tx as StorageDb, existing)
      if (environmentId !== null && !existing.isCommon) await lockEnvironmentRow(tx, environmentId)
      const locked = await refuseLockedFolderPatch(c, tx as StorageDb, existing, body)
      if (locked) return locked
      await tx.update(storage).set(updateFields).where(eq(storage.id, id))
      // A new folder name is accepted until the volume has a folder (checked above).
      if (typeof body.slug === 'string' && body.slug !== existing.slug) {
        await nameVolumeFolder(tx as StorageDb, {
          storageId: id,
          organizationId: existing.organizationId,
          principalId:
            'principalId' in updateFields
              ? (updateFields.principalId as string | null)
              : existing.principalId,
          name: existing.name,
          isCommon: existing.isCommon,
          environmentId: await resolveVolumeEnvironmentId(tx as StorageDb, existing),
          options: { slug: body.slug },
        })
      }
      return null
    })
    if (refused) return refused
  } catch (err) {
    if (err instanceof FolderPlanError) return c.json(err.body(), err.status)
    throw err
  }
  return c.json({ ok: true as const })
}

export async function requireStorageForNested(
  c: Context<AppEnv>,
  db: StorageDb,
  orgId: string,
  storageId: string,
  mode: 'read' | 'manage'
): Promise<Response | StorageRow> {
  const entityOrgId = await resolveEntityOrganizationId(db, 'storage', storageId)
  if (!entityOrgId || entityOrgId !== orgId) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied =
    mode === 'read'
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
  router.use('/storage/:id/copies', createSessionMiddleware(secrets))
  router.use('/storage/:id/copies/:copyId', createSessionMiddleware(secrets))
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

      const parentOrgId = await resolveEntityOrganizationId(db, parentFilter.entityKind, parentId)
      if (!parentOrgId || parentOrgId !== orgResult) {
        return c.json({ error: 'Not found' }, 404)
      }

      const denied = await assertCanReadOr403(c, parentFilter.entityKind, parentId)
      if (denied) return denied

      const rows = await db
        .select(STORAGE_SELECT)
        .from(storage)
        .leftJoin(principal, eq(storage.principalId, principal.id))
        .where(
          and(eq(storage.organizationId, orgResult), eq(storage[parentFilter.column], parentId))
        )
      const { copiesByStorage, mountsByStorage } = await loadStorageChildren(
        db,
        rows.map((row) => row.id)
      )
      return c.json({
        storage: rows.map((row) =>
          serializeStorage(
            row,
            copiesByStorage.get(row.id) ?? [],
            mountsByStorage.get(row.id) ?? []
          )
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

    const { copiesByStorage, mountsByStorage } = await loadStorageChildren(
      db,
      rows.map((row) => row.id)
    )
    return c.json({
      storage: rows.map((row) =>
        serializeStorage(row, copiesByStorage.get(row.id) ?? [], mountsByStorage.get(row.id) ?? [])
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

    const { copiesByStorage, mountsByStorage } = await loadStorageChildren(db, [id])
    return c.json({
      storage: serializeStorage(row, copiesByStorage.get(id) ?? [], mountsByStorage.get(id) ?? []),
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

    // A new principal or pinned volume name moves where a copy's bytes live.
    const backupHosts = await captureCopyBackupHosts(ctx.db, c.get('commandQueue'), {
      storageId: id,
    })
    const response = await patchStorageRecord(c, ctx.db, id, existing!, body)
    if (response.ok) await repushCopyBackups(c, ctx.db, [], backupHosts)
    return response
  })

  router.delete('/storage/:id', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx

    const id = c.req.param('id')
    const [existing] = await ctx.db.select().from(storage).where(eq(storage.id, id)).limit(1)

    const authorized = await authorizeStorageMutation(c, existing, ctx.orgId)
    if (authorized instanceof Response) return authorized

    const stepUp = await requireStepUpIfConfigured(c, ctx.orgId, 'storage.delete')
    if (stepUp) return stepUp

    // A shared volume cannot go while another environment uses it.
    const uses = await listUsesOfAssets(ctx.db, { storageIds: [id] })
    if (uses.length > 0) return c.json(inUseBody(uses), 409)

    const backupHosts = await captureCopyBackupHosts(ctx.db, c.get('commandQueue'), {
      storageId: id,
    })
    // The folder rows stay, locked, until the host confirms the folder is gone.
    await ctx.db.transaction(async (tx) => {
      await markAssetFoldersRemoving(tx, { storageIds: [id] })
      await tx.delete(storage).where(eq(storage.id, id))
    })
    await repushCopyBackups(c, ctx.db, [], backupHosts)
    return c.json({ ok: true as const })
  })

  router.get('/storage/:id/copies', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'read')
    if (row instanceof Response) return row

    const copyRows = await ctx.db
      .select(COPY_SELECT)
      .from(storageCopy)
      .where(eq(storageCopy.storageId, storageId))
    let principalUsername: string | null = null
    if (row.principalId) {
      const [principalRow] = await ctx.db
        .select({ username: principal.appliedUsername })
        .from(principal)
        .where(eq(principal.id, row.principalId))
        .limit(1)
      principalUsername = principalRow?.username ?? null
    }
    return c.json({
      copies: copyRows.map((copy) => serializeCopy(copy, storageId, principalUsername)),
    })
  })

  router.post('/storage/:id/copies', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const fields = parseCopyRecord(c, body)
    if (fields instanceof Response) return fields

    const copyRefError = await validateCopyRefsInOrg(c, ctx.db, ctx.orgId, fields)
    if (copyRefError) return copyRefError
    const ownershipError = await validateCopyOwnership(c, ctx.db, row.principalId, fields)
    if (ownershipError) return ownershipError

    try {
      const id = await ctx.db.transaction(async (tx) => {
        const copyId = await insertCopyRow(tx as StorageDb, storageId, fields)
        if (fields.provider === 'path' && row.slug !== null) {
          await planVolumeFolder(tx as StorageDb, { storageId, serverId: fields.serverId })
        }
        return copyId
      })
      return c.json({ ok: true as const, id })
    } catch (err) {
      if (err instanceof FolderPlanError) return c.json(err.body(), err.status)
      return uniqueViolationResponse(c, err)
    }
  })

  router.patch('/storage/:id/copies/:copyId', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const copyId = c.req.param('copyId')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const [existing] = await ctx.db
      .select({ id: storageCopy.id, storageId: storageCopy.storageId })
      .from(storageCopy)
      .where(and(eq(storageCopy.id, copyId), eq(storageCopy.storageId, storageId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const updateFields = parseCopyPatchFields(c, body)
    if (updateFields instanceof Response) return updateFields

    const copyRefError = await validateCopyRefsInOrg(c, ctx.db, ctx.orgId, updateFields)
    if (copyRefError) return copyRefError
    const ownershipError = await validateCopyOwnership(c, ctx.db, row.principalId, {
      // Only a path being written is checked; an unrelated edit of a copy that
      // predates the rule is left alone (the host refuses its path on deploy).
      path: 'path' in updateFields ? updateFields.path : undefined,
      options: updateFields.options,
    })
    if (ownershipError) return ownershipError

    // A move, a new path or provider changes which host runs the copy's
    // backup timers, and what they read.
    const backupHosts = await captureCopyBackupHosts(ctx.db, c.get('commandQueue'), {
      copyIds: [copyId],
    })
    try {
      await ctx.db.update(storageCopy).set(updateFields).where(eq(storageCopy.id, copyId))
    } catch (err) {
      return uniqueViolationResponse(c, err)
    }
    await repushCopyBackups(c, ctx.db, [copyId], backupHosts)
    return c.json({ ok: true as const })
  })

  router.delete('/storage/:id/copies/:copyId', async (c) => {
    const ctx = await resolveStorageSessionContext(c)
    if (ctx instanceof Response) return ctx
    const storageId = c.req.param('id')
    const copyId = c.req.param('copyId')
    const row = await requireStorageForNested(c, ctx.db, ctx.orgId, storageId, 'manage')
    if (row instanceof Response) return row

    const stepUp = await requireStepUpIfConfigured(c, ctx.orgId, 'storage.copy.delete')
    if (stepUp) return stepUp

    const backupHosts = await captureCopyBackupHosts(ctx.db, c.get('commandQueue'), {
      copyIds: [copyId],
    })
    const deleted = await ctx.db.transaction(async (tx) => {
      const removed = await tx
        .delete(storageCopy)
        .where(and(eq(storageCopy.id, copyId), eq(storageCopy.storageId, storageId)))
        .returning({ id: storageCopy.id, serverId: storageCopy.serverId })
      // The copy's folder on that server waits, locked, for the host to confirm.
      const serverId = removed[0]?.serverId
      if (serverId) await markVolumeFolderRemoving(tx, { storageId, serverId })
      return removed
    })
    if (deleted.length === 0) return c.json({ error: 'Not found' }, 404)
    // Its policies cascaded away; the host drops their timers.
    await repushCopyBackups(c, ctx.db, [], backupHosts)
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
