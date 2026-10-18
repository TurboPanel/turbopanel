/**
 * Writes for the folder table: choosing the folder name of a service or volume,
 * planning its folder rows on a server, and moving them along their states.
 *
 * Every plan runs inside the caller's transaction and starts by taking the
 * environment row's lock (`lockEnvironmentRow`), the same lock an environment
 * rename takes, so a rename and the first folder of an environment cannot both
 * succeed. The first folder row of an organization also sets
 * `directoryNamesLocked` on it, in the same transaction.
 *
 * The folder name of an asset is settled once: the organization setting picks
 * slug or uuid, a typed name is checked and never suffixed, a defaulted name
 * gets `-2` to `-99` on a clash. A row at the same server, site owner, scope,
 * kind and name is the final guard (`uniq_folder_location`).
 */
import { and, eq, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm'
import {
  COMMON_SCOPE,
  type FolderRefParts,
  isValidEnvironmentName,
} from '../../contracts/directory-names.ts'
import type { Db } from '../../db/connection.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  environment,
  folder,
  organization,
  principal,
  service,
  storage,
  tenancy,
} from '../../db/schema.ts'
import {
  parseOrganizationOptions,
  resolveDirectoryNames,
} from '../organizations/organization-options.ts'
import { defaultFolderBase, resolveDirectoryNameChoice, resolveFolderName } from './names.ts'
import { lockEnvironmentRow, type Reader } from './records.ts'
import type { DirectoryNameChoice } from './names.ts'
import type { DirectoryNameMode, FolderKindValue } from './vocabulary.ts'

export type FolderPlanErrorCode =
  | 'invalid_environment_name'
  | 'invalid_directory_name'
  | 'directory_name_taken'
  | 'directory_name_typed_in_uuid_mode'
  | 'directory_name_mode_forbidden'

const PLAN_ERROR_MESSAGES: Record<FolderPlanErrorCode, string> = {
  invalid_environment_name:
    "This environment's name cannot be used as a folder name. Rename the environment (lowercase letters, digits, hyphens and underscores, at most 32 characters) before deploying.",
  invalid_directory_name:
    'A folder name uses lowercase letters, digits, dots, hyphens and underscores, starts and ends with a letter or digit, and is at most 63 characters.',
  directory_name_taken:
    'Another service or volume of this site owner already uses that folder name in the same place. Choose a different name.',
  directory_name_typed_in_uuid_mode:
    'This organization names folders after the id, so a folder name cannot be typed.',
  directory_name_mode_forbidden:
    'This organization does not allow that kind of folder name. See the folder naming setting.',
}

/** A refusal the person can act on; the routes answer it with 400 or 409. */
export class FolderPlanError extends Error {
  readonly code: FolderPlanErrorCode
  readonly status: 400 | 409

  constructor(code: FolderPlanErrorCode) {
    super(PLAN_ERROR_MESSAGES[code])
    this.name = 'FolderPlanError'
    this.code = code
    this.status =
      code === 'invalid_directory_name' || code === 'directory_name_mode_forbidden' ? 400 : 409
  }

  body(): { error: FolderPlanErrorCode; message: string } {
    return { error: this.code, message: this.message }
  }
}

/** What a folder name choice at creation asks for. */
export type FolderNameRequest = {
  /** A name the person typed; never suffixed. */
  typed?: string
  /** `slug` or `uuid`; only accepted when the organization allows both. */
  choice?: DirectoryNameChoice
}

/** The organization's folder naming setting, read under no lock (for creation checks). */
export async function readDirectoryNameMode(
  db: Reader,
  organizationId: string
): Promise<DirectoryNameMode> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return resolveDirectoryNames(parseOrganizationOptions(row?.options)).mode
}

/**
 * Read the setting with the organization row locked until the transaction
 * ends, so a change of the setting waits for the folder being planned.
 */
async function readDirectoryNameModeLocked(
  tx: Reader,
  organizationId: string
): Promise<DirectoryNameMode> {
  const [row] = await tx
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .for('no key update')
    .limit(1)
  return resolveDirectoryNames(parseOrganizationOptions(row?.options)).mode
}

/** Set `directoryNamesLocked` on the organization (idempotent, one atomic jsonb write). */
export async function lockDirectoryNames(
  tx: Pick<Db, 'update'>,
  organizationId: string
): Promise<void> {
  await tx
    .update(organization)
    .set({
      options: sql`COALESCE(${organization.options}, '{}'::jsonb) || '{"directoryNamesLocked": true}'::jsonb`,
    })
    .where(
      and(
        eq(organization.id, organizationId),
        sql`COALESCE((${organization.options} ->> 'directoryNamesLocked')::boolean, false) = false`
      )
    )
}

type TakenQuery = {
  kind: FolderKindValue
  principalId: string
  scope: string
  /** Names starting with this are fetched (the whole name for an exact check). */
  prefix: string
  /** The asset being named; its own rows never count as a clash. */
  exceptAssetId?: string
}

/**
 * The names starting with `prefix` that the site owner already uses in that
 * scope and kind: by a folder row on any server, or by an asset that has the
 * name but no folder yet (so a clash shows at creation, not at the first
 * deploy).
 */
export async function takenFolderNames(db: Reader, query: TakenQuery): Promise<Set<string>> {
  const assetColumn = query.kind === 'service' ? folder.serviceId : folder.storageId
  const folderRows = await db
    .select({ slug: folder.slug })
    .from(folder)
    .where(
      and(
        eq(folder.principalId, query.principalId),
        eq(folder.scope, query.scope),
        eq(folder.kind, query.kind),
        like(folder.slug, `${query.prefix}%`),
        query.exceptAssetId === undefined
          ? undefined
          : or(isNull(assetColumn), ne(assetColumn, query.exceptAssetId))
      )
    )
  const assetSlugs =
    query.kind === 'service' ? await serviceSlugs(db, query) : await volumeSlugs(db, query)
  return new Set([...folderRows.map((row) => row.slug), ...assetSlugs])
}

async function serviceSlugs(db: Reader, query: TakenQuery): Promise<string[]> {
  const common = query.scope === COMMON_SCOPE
  const rows = await db
    .select({ slug: service.slug })
    .from(service)
    .innerJoin(
      tenancy,
      and(eq(tenancy.serviceId, service.id), eq(tenancy.principalId, query.principalId))
    )
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .where(
      and(
        like(service.slug, `${query.prefix}%`),
        query.exceptAssetId === undefined ? undefined : ne(service.id, query.exceptAssetId),
        common
          ? eq(service.isCommon, true)
          : and(eq(service.isCommon, false), eq(environment.name, query.scope))
      )
    )
  return rows.flatMap((row) => (row.slug === null ? [] : [row.slug]))
}

async function volumeSlugs(db: Reader, query: TakenQuery): Promise<string[]> {
  const common = query.scope === COMMON_SCOPE
  const rows = await db
    .select({ slug: storage.slug })
    .from(storage)
    .leftJoin(service, eq(service.id, storage.serviceId))
    .leftJoin(
      environment,
      eq(environment.id, sql`COALESCE(${storage.environmentId}, ${service.environmentId})`)
    )
    .where(
      and(
        eq(storage.principalId, query.principalId),
        like(storage.slug, `${query.prefix}%`),
        query.exceptAssetId === undefined ? undefined : ne(storage.id, query.exceptAssetId),
        common
          ? eq(storage.isCommon, true)
          : and(eq(storage.isCommon, false), eq(environment.name, query.scope))
      )
    )
  return rows.flatMap((row) => (row.slug === null ? [] : [row.slug]))
}

export type SettledFolderName = {
  slug: string
}

/**
 * Settle the folder name of a new or still-unnamed asset. With no site owner
 * yet (`principalId` null) nothing can clash, so the check is skipped and runs
 * again when the owner is bound and the first folder is planned.
 */
export async function settleFolderName(
  db: Reader,
  input: {
    mode: DirectoryNameMode
    kind: FolderKindValue
    assetId: string
    principalId: string | null
    scope: string
    request: FolderNameRequest
    domain?: string | null
    label?: string | null
  }
): Promise<SettledFolderName> {
  const resolution = resolveDirectoryNameChoice(input.mode, input.request.choice)
  if (!resolution.ok) throw new FolderPlanError(resolution.error)
  const base = defaultFolderBase({
    domain: input.domain ?? null,
    label: input.label ?? null,
    assetId: input.assetId,
  })
  const probe = resolution.choice === 'uuid' ? input.assetId : (input.request.typed ?? base)
  const taken =
    input.principalId === null
      ? new Set<string>()
      : await takenFolderNames(db, {
          kind: input.kind,
          principalId: input.principalId,
          scope: input.scope,
          // Suffixed names (`base-2`) share the base as their prefix; a name cut to fit
          // is still covered by its first characters.
          prefix: probe.slice(0, Math.max(1, probe.length - 3)),
          exceptAssetId: input.assetId,
        })
  const result = resolveFolderName({
    choice: resolution.choice,
    assetId: input.assetId,
    ...(input.request.typed === undefined ? {} : { typed: input.request.typed }),
    defaultBase: base,
    isTaken: (name) => taken.has(name),
  })
  if (!result.ok) throw new FolderPlanError(result.error)
  return { slug: result.slug }
}

// -- Planning folder rows ----------------------------------------------------

export type PlannedFolders = {
  /** Ids of the folder rows this plan relies on (new or already there). */
  folderIds: string[]
  /** Folder reference per service id. */
  services: Map<string, FolderRefParts>
  /** Folder reference per volume (storage) id. */
  volumes: Map<string, FolderRefParts>
}

export type PlanServiceInput = {
  /** The service row, or its compose key when only that is known. */
  serviceId?: string
  composeServiceName?: string
  /** The site owner when the caller already knows it; else the sole tenancy edge. */
  principalId?: string
  /** The primary domain, used once as the default name of a web hosting service. */
  domain?: string | null
}

export type PlanDeployFoldersInput = {
  organizationId: string
  environmentId: string
  serverId: string
  services: readonly PlanServiceInput[]
  volumeIds: readonly string[]
}

type OwnerRow = { id: string; username: string }

async function loadOwners(
  tx: Reader,
  principalIds: readonly string[]
): Promise<Map<string, OwnerRow>> {
  const ids = [...new Set(principalIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx
    .select({ id: principal.id, username: principal.appliedUsername })
    .from(principal)
    .where(inArray(principal.id, ids))
  const out = new Map<string, OwnerRow>()
  for (const row of rows) {
    if (row.username) out.set(row.id, { id: row.id, username: row.username })
  }
  return out
}

async function soleTenancyOwners(
  tx: Reader,
  serviceIds: readonly string[]
): Promise<Map<string, string>> {
  if (serviceIds.length === 0) return new Map()
  const rows = await tx
    .select({ serviceId: tenancy.serviceId, principalId: tenancy.principalId })
    .from(tenancy)
    .where(inArray(tenancy.serviceId, [...serviceIds]))
  const byService = new Map<string, string[]>()
  for (const row of rows) {
    byService.set(row.serviceId, [...(byService.get(row.serviceId) ?? []), row.principalId])
  }
  const sole = new Map<string, string>()
  for (const [serviceId, ids] of byService) {
    if (ids.length === 1 && ids[0] !== undefined) sole.set(serviceId, ids[0])
  }
  return sole
}

type FolderTarget = {
  kind: FolderKindValue
  assetId: string
  environmentId: string | null
  principalId: string
  username: string
  scope: string
  slug: string
}

/**
 * Plan the folder rows one server needs for a deploy: a service folder for each
 * listed service that has a site owner, a volume folder for each listed volume.
 * Gives each asset its folder name first when it has none. Returns the folder
 * references to put on the wire and the ids of the rows (state `planned`, or
 * whatever state an earlier deploy already took them to).
 *
 * Call it inside a transaction. A scope that is an environment name must be a
 * valid folder name; an older environment named otherwise is refused here with
 * a message that tells the person to rename it.
 */
export async function planDeployFolders(
  tx: Db,
  input: PlanDeployFoldersInput
): Promise<PlannedFolders> {
  const planned: PlannedFolders = { folderIds: [], services: new Map(), volumes: new Map() }
  if (input.services.length === 0 && input.volumeIds.length === 0) return planned

  await lockEnvironmentRow(tx, input.environmentId)
  const [envRow] = await tx
    .select({ name: environment.name })
    .from(environment)
    .where(eq(environment.id, input.environmentId))
    .limit(1)
  const environmentName = envRow?.name ?? null

  const targets: FolderTarget[] = []
  // The setting is read (and its row locked) only when an asset still needs a name.
  let modeRead: Promise<DirectoryNameMode> | undefined
  const modeOf = () => (modeRead ??= readDirectoryNameModeLocked(tx, input.organizationId))
  await collectServiceTargets(tx, input, modeOf, environmentName, targets)
  await collectVolumeTargets(tx, input, modeOf, environmentName, targets)

  await forEachSequential(targets, async (target) => {
    const folderId = await upsertFolderRow(tx, input.serverId, target)
    planned.folderIds.push(folderId)
    const ref: FolderRefParts = { owner: target.username, scope: target.scope, slug: target.slug }
    if (target.kind === 'service') planned.services.set(target.assetId, ref)
    else planned.volumes.set(target.assetId, ref)
  })
  if (planned.folderIds.length > 0) await lockDirectoryNames(tx, input.organizationId)
  return planned
}

/** The scope folder for an asset: `common`, or the environment name when that is a valid folder name. */
export function scopeFor(isCommon: boolean, environmentName: string | null): string {
  if (isCommon) return COMMON_SCOPE
  if (environmentName === null || !isValidEnvironmentName(environmentName)) {
    throw new FolderPlanError('invalid_environment_name')
  }
  return environmentName
}

async function collectServiceTargets(
  tx: Db,
  input: PlanDeployFoldersInput,
  modeOf: () => Promise<DirectoryNameMode>,
  environmentName: string | null,
  targets: FolderTarget[]
): Promise<void> {
  if (input.services.length === 0) return
  const ids = input.services.flatMap((entry) => (entry.serviceId ? [entry.serviceId] : []))
  const names = input.services.flatMap((entry) =>
    entry.composeServiceName ? [entry.composeServiceName] : []
  )
  const rows = await tx
    .select({
      id: service.id,
      name: service.name,
      composeServiceName: service.composeServiceName,
      slug: service.slug,
      isCommon: service.isCommon,
    })
    .from(service)
    .where(
      and(
        eq(service.environmentId, input.environmentId),
        or(
          ids.length > 0 ? inArray(service.id, ids) : undefined,
          names.length > 0 ? inArray(service.composeServiceName, names) : undefined
        )
      )
    )
  const byId = new Map(rows.map((row) => [row.id, row]))
  const byName = new Map(rows.map((row) => [row.composeServiceName, row]))
  const resolved = input.services.flatMap((entry) => {
    const row =
      (entry.serviceId ? byId.get(entry.serviceId) : undefined) ??
      (entry.composeServiceName ? byName.get(entry.composeServiceName) : undefined)
    return row ? [{ entry, row }] : []
  })
  const needOwner = resolved.filter(({ entry }) => entry.principalId === undefined)
  const sole = await soleTenancyOwners(
    tx,
    needOwner.map(({ row }) => row.id)
  )
  const owners = await loadOwners(tx, [
    ...resolved.flatMap(({ entry }) => (entry.principalId ? [entry.principalId] : [])),
    ...sole.values(),
  ])
  await forEachSequential(resolved, async ({ entry, row }) => {
    const principalId = entry.principalId ?? sole.get(row.id)
    const owner = principalId === undefined ? undefined : owners.get(principalId)
    if (!owner) return
    const scope = scopeFor(row.isCommon, environmentName)
    if (row.slug === null) {
      const settled = await settleFolderName(tx, {
        mode: await modeOf(),
        kind: 'service',
        assetId: row.id,
        principalId: owner.id,
        scope,
        request: {},
        domain: entry.domain ?? null,
        label: row.name ?? row.composeServiceName,
      })
      await writeServiceFolderName(tx, row.id, { slug: settled.slug }, true)
      row.slug = settled.slug
    }
    targets.push({
      kind: 'service',
      assetId: row.id,
      environmentId: row.isCommon ? null : input.environmentId,
      principalId: owner.id,
      username: owner.username,
      scope,
      slug: row.slug as string,
    })
  })
}

async function collectVolumeTargets(
  tx: Db,
  input: PlanDeployFoldersInput,
  modeOf: () => Promise<DirectoryNameMode>,
  environmentName: string | null,
  targets: FolderTarget[]
): Promise<void> {
  if (input.volumeIds.length === 0) return
  const rows = await tx
    .select({
      id: storage.id,
      name: storage.name,
      slug: storage.slug,
      isCommon: storage.isCommon,
      principalId: storage.principalId,
      environmentId: storage.environmentId,
    })
    .from(storage)
    .where(inArray(storage.id, [...new Set(input.volumeIds)]))
  const owners = await loadOwners(
    tx,
    rows.flatMap((row) => (row.principalId ? [row.principalId] : []))
  )
  await forEachSequential(rows, async (row) => {
    const owner = row.principalId ? owners.get(row.principalId) : undefined
    if (!owner) return
    const ownEnvironment = row.environmentId === null || row.environmentId === input.environmentId
    // A volume of another environment is only planned through its own deploy.
    if (!row.isCommon && !ownEnvironment) return
    const scope = scopeFor(row.isCommon, environmentName)
    if (row.slug === null) {
      const settled = await settleFolderName(tx, {
        mode: await modeOf(),
        kind: 'volume',
        assetId: row.id,
        principalId: owner.id,
        scope,
        request: {},
        label: row.name,
      })
      await tx
        .update(storage)
        .set({ slug: settled.slug })
        .where(and(eq(storage.id, row.id), isNull(storage.slug)))
      row.slug = settled.slug
    }
    targets.push({
      kind: 'volume',
      assetId: row.id,
      environmentId: row.isCommon ? null : input.environmentId,
      principalId: owner.id,
      username: owner.username,
      scope,
      slug: row.slug as string,
    })
  })
}

/** Insert the planned row, or find the one that is already there for this very asset. */
async function upsertFolderRow(tx: Db, serverId: string, target: FolderTarget): Promise<string> {
  await tx
    .insert(folder)
    .values({
      serverId,
      principalId: target.principalId,
      environmentId: target.environmentId,
      scope: target.scope,
      kind: target.kind,
      slug: target.slug,
      serviceId: target.kind === 'service' ? target.assetId : null,
      storageId: target.kind === 'volume' ? target.assetId : null,
      state: 'planned',
    })
    .onConflictDoNothing({
      target: [folder.serverId, folder.principalId, folder.scope, folder.kind, folder.slug],
    })
  const [row] = await tx
    .select({
      id: folder.id,
      serviceId: folder.serviceId,
      storageId: folder.storageId,
      state: folder.state,
    })
    .from(folder)
    .where(
      and(
        eq(folder.serverId, serverId),
        eq(folder.principalId, target.principalId),
        eq(folder.scope, target.scope),
        eq(folder.kind, target.kind),
        eq(folder.slug, target.slug)
      )
    )
    .limit(1)
  const owner = target.kind === 'service' ? row?.serviceId : row?.storageId
  if (!row || owner !== target.assetId) throw new FolderPlanError('directory_name_taken')
  // The asset is back on this server (a server re-added, a copy re-added) before the host
  // confirmed the removal: the folder is in use again, so it must not be confirmed away.
  // An orphan kept when its service left the compose file is in use again too.
  if (row.state === 'removing' || row.state === 'orphan') {
    await tx.update(folder).set({ state: 'planned' }).where(eq(folder.id, row.id))
  }
  return row.id
}

/**
 * Store a service's folder name (and scope). Two services of one environment
 * cannot share a name; the unique index is the guard when the clash check could
 * not see the other service (it has no site owner yet), and it answers in plain
 * words like the check does.
 */
export async function writeServiceFolderName(
  tx: Pick<Db, 'update'>,
  serviceId: string,
  values: { slug: string; isCommon?: boolean },
  onlyIfUnset = false
): Promise<void> {
  try {
    await tx
      .update(service)
      .set(values)
      .where(and(eq(service.id, serviceId), onlyIfUnset ? isNull(service.slug) : undefined))
  } catch (err) {
    if (isUniqueViolationOn(err, 'uniq_service_environment_slug')) {
      throw new FolderPlanError('directory_name_taken')
    }
    throw err
  }
}

/**
 * Plan the folder row of one panel-owned volume on one server, when its path
 * copy is added: the site owner and the folder name are known by then. Does
 * nothing for a volume with no owner or no folder name yet (the deploy plans it
 * later). Inside the caller's transaction; takes the environment row's lock for
 * a volume in an environment's own scope.
 */
export async function planVolumeFolder(
  tx: Db,
  input: { storageId: string; serverId: string }
): Promise<string | null> {
  const [row] = await tx
    .select({
      id: storage.id,
      organizationId: storage.organizationId,
      slug: storage.slug,
      isCommon: storage.isCommon,
      principalId: storage.principalId,
      environmentId: sql<
        string | null
      >`COALESCE(${storage.environmentId}, ${service.environmentId})`,
    })
    .from(storage)
    .leftJoin(service, eq(service.id, storage.serviceId))
    .where(eq(storage.id, input.storageId))
    .limit(1)
  if (!row || row.slug === null || row.principalId === null) return null
  const [owner] = (await loadOwners(tx, [row.principalId])).values()
  if (!owner) return null
  let environmentName: string | null = null
  if (!row.isCommon) {
    if (row.environmentId === null) return null
    await lockEnvironmentRow(tx, row.environmentId)
    const [env] = await tx
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.id, row.environmentId))
      .limit(1)
    environmentName = env?.name ?? null
  }
  const scope = scopeFor(row.isCommon, environmentName)
  const id = await upsertFolderRow(tx, input.serverId, {
    kind: 'volume',
    assetId: row.id,
    environmentId: row.isCommon ? null : row.environmentId,
    principalId: owner.id,
    username: owner.username,
    scope,
    slug: row.slug,
  })
  await lockDirectoryNames(tx, row.organizationId)
  return id
}

// -- Moving rows along their states ------------------------------------------

/** A deploy succeeded: the rows it planned are on the host. */
export async function markFoldersPresent(
  db: Pick<Db, 'update'>,
  folderIds: readonly string[]
): Promise<void> {
  if (folderIds.length === 0) return
  await db
    .update(folder)
    .set({ state: 'present' })
    .where(and(inArray(folder.id, [...folderIds]), eq(folder.state, 'planned')))
}

/**
 * Assets are being deleted: their folder rows stay and keep their locks until
 * the host confirms removal. Call before the asset rows go (the foreign keys
 * clear the asset ids when they do).
 */
export async function markAssetFoldersRemoving(
  db: Pick<Db, 'update'>,
  assets: { serviceIds?: readonly string[]; storageIds?: readonly string[] }
): Promise<string[]> {
  const serviceIds = assets.serviceIds ?? []
  const storageIds = assets.storageIds ?? []
  if (serviceIds.length === 0 && storageIds.length === 0) return []
  const match = or(
    serviceIds.length > 0 ? inArray(folder.serviceId, [...serviceIds]) : undefined,
    storageIds.length > 0 ? inArray(folder.storageId, [...storageIds]) : undefined
  )
  const rows = await db
    .update(folder)
    .set({ state: 'removing' })
    // An orphan (kept when its service left the compose file) goes with an explicit delete.
    .where(and(match, inArray(folder.state, ['planned', 'present', 'orphan'])))
    .returning({ serverId: folder.serverId })
  return [...new Set(rows.map((row) => row.serverId))]
}

/**
 * A volume's copy on one server is being removed: that server's folder waits,
 * locked, for the host. Returns the servers to tell (the one, when a row moved).
 */
export async function markVolumeFolderRemoving(
  db: Pick<Db, 'update'>,
  where: { storageId: string; serverId: string }
): Promise<string[]> {
  const rows = await db
    .update(folder)
    .set({ state: 'removing' })
    .where(
      and(
        eq(folder.storageId, where.storageId),
        eq(folder.serverId, where.serverId),
        inArray(folder.state, ['planned', 'present'])
      )
    )
    .returning({ serverId: folder.serverId })
  return [...new Set(rows.map((row) => row.serverId))]
}

/**
 * An environment's release trees are being reclaimed on one server: that
 * server's service folders for the environment wait, locked, for the host to
 * confirm. Volume folders stay; a stop never removes data.
 */
export async function markServerServiceFoldersRemoving(
  db: Pick<Db, 'update'>,
  where: { environmentId: string; serverId: string }
): Promise<void> {
  await db
    .update(folder)
    .set({ state: 'removing' })
    .where(
      and(
        eq(folder.environmentId, where.environmentId),
        eq(folder.serverId, where.serverId),
        eq(folder.kind, 'service'),
        inArray(folder.state, ['planned', 'present'])
      )
    )
}

/**
 * The host confirmed a folder is gone: delete the row, which lifts its locks.
 * The four components name it; a row in any state but `removing` is left
 * alone so a stale report cannot lift a lock on a folder that is in use.
 */
export async function confirmFolderRemoved(
  db: Pick<Db, 'delete'>,
  where: {
    serverId: string
    principalId: string
    scope: string
    kind: FolderKindValue
    slug: string
    /**
     * Only a row last changed before this time is deleted: a report about a
     * command built earlier must not clear a row that was planned again since.
     */
    updatedBefore?: string
  }
): Promise<boolean> {
  const deleted = await db
    .delete(folder)
    .where(
      and(
        eq(folder.serverId, where.serverId),
        eq(folder.principalId, where.principalId),
        eq(folder.scope, where.scope),
        eq(folder.kind, where.kind),
        eq(folder.slug, where.slug),
        eq(folder.state, 'removing'),
        where.updatedBefore === undefined ? undefined : lt(folder.updatedAt, where.updatedBefore)
      )
    )
    .returning({ id: folder.id })
  return deleted.length > 0
}
