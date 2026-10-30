/**
 * What deleting a project (or one environment) will remove and keep, read
 * before anything changes: the environments and services, every folder on
 * every server with its path and whether it goes or stays, the site owners'
 * Linux users (Hosting Accounts) that go with the project, the Let's Encrypt
 * certificates made for its sites (removed, or kept while another site uses
 * one), and the reasons the delete cannot run yet. The delete confirmation shows it, and the delete
 * routes refuse on its blockers before they stop anything.
 *
 * Offline servers refuse, they are not queued: the stop that a delete sends
 * first cannot wait for a server that is not connected (the command fails at
 * once), so a delete that went ahead would leave that server's stack running
 * with nothing left that names it. Once the stop is out, folder removal and
 * Hosting Account removal are queued: a server that drops off afterwards is
 * asked again by the folder removal sweep, and a Hosting Account is removed
 * by the principal removal sweep once its folders are gone and its servers
 * are connected.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  environment,
  folder,
  hosting,
  managed,
  principal,
  server,
  service,
  storage,
} from '../../db/schema.ts'
import { folderHostPath } from '../../contracts/directory-names.ts'
import { PRINCIPAL_HOME_ROOT } from '../../lib/naming.ts'
import { listStorageIdsDeletedWith } from '../storage/storage-records.ts'
import { classifyProjectPrincipals } from '../principals/removal.ts'
import type { PrincipalReferences } from '../principals/store.ts'
import { COMMON_ASSET_IN_USE_ERROR } from '../folders/shares.ts'
import { PRIMARY_ENVIRONMENT_DELETE_ERROR } from './primary-environment.ts'
import { planSiteCertificates, type SiteCertificateFate } from '../tls/unused-letsencrypt.ts'
import {
  ENVIRONMENT_DEPLOY_RUNNING_MESSAGE,
  ENVIRONMENT_RUNNING_ERROR,
  hasInProgressDeployment,
  MANAGED_PRESENT_MESSAGE,
  MANAGED_RUNTIME_PRESENT_ERROR,
  PROJECT_DEPLOY_RUNNING_ERROR,
  PROJECT_DEPLOY_RUNNING_MESSAGE,
  sharedAssetsStillUsed,
} from './project-delete.ts'

export const SERVER_OFFLINE_ERROR = 'server_offline'

export type DeletePlanServer = {
  id: string
  name: string | null
  hostname: string | null
  connected: boolean
}

export type DeletePlanFolder = {
  id: string
  serverId: string
  kind: 'service' | 'volume'
  /** Host path, `/srv/users/{owner}/{scope}/services|volumes/{name}`; null for an old row whose names fail the rules. */
  path: string | null
  /** The service or volume it belongs to, when that row still exists. */
  assetName: string | null
  /** `remove`: deleted from the server. `keep`: a volume set to keep its data. */
  action: 'remove' | 'keep'
}

export type DeletePlanHostingAccount = {
  id: string
  username: string
  action: 'remove' | 'keep'
  /** For `keep`: what outside the project still uses it. */
  usedBy?: PrincipalReferences
}

export type DeletePlanBlocker = {
  error: string
  message: string
  /** For `server_offline`: the servers that are not connected. */
  serverIds?: string[]
  /** For `common_asset_in_use`: who still uses the shared asset. */
  uses?: unknown
}

export type DeletePlan = {
  environments: Array<{ id: string; name: string | null }>
  services: Array<{ id: string; name: string | null; environmentId: string }>
  servers: DeletePlanServer[]
  folders: DeletePlanFolder[]
  /** Only for a project delete; an environment delete keeps the project's Hosting Accounts. */
  hostingAccounts: DeletePlanHostingAccount[]
  /** The Let's Encrypt certificates made for these sites: removed, or kept while another site uses one. */
  certificates: SiteCertificateFate[]
  blockers: DeletePlanBlocker[]
}

export type DeletePlanInput = {
  /** Set for a project delete: the project's Hosting Accounts are planned too. */
  projectId?: string
  environmentIds: readonly string[]
  /** Servers the delete has to reach with a stop (its teardown targets). */
  stopServerIds: readonly string[]
}

/** A refusal's `message` when it is text, else empty. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Sort in place by a name, then by id, and return the array. */
function sortByName<T extends { id: string }>(rows: T[], name: (row: T) => string): T[] {
  return rows.sort((a, b) => name(a).localeCompare(name(b)) || a.id.localeCompare(b.id))
}

function hostPath(owner: string, scope: string, kind: 'service' | 'volume', slug: string) {
  try {
    return folderHostPath(PRINCIPAL_HOME_ROOT, { owner, scope, kind, slug })
  } catch {
    return null
  }
}

async function loadPlanFolders(
  db: Pick<Db, 'select'>,
  scope: { environmentIds: readonly string[]; serviceIds: string[]; storageIds: string[] }
): Promise<DeletePlanFolder[]> {
  const match = or(
    scope.environmentIds.length > 0
      ? inArray(folder.environmentId, [...scope.environmentIds])
      : undefined,
    scope.serviceIds.length > 0 ? inArray(folder.serviceId, scope.serviceIds) : undefined,
    scope.storageIds.length > 0 ? inArray(folder.storageId, scope.storageIds) : undefined
  )
  if (!match) return []
  const rows = await db
    .select({
      id: folder.id,
      serverId: folder.serverId,
      kind: folder.kind,
      scope: folder.scope,
      slug: folder.slug,
      storageId: folder.storageId,
      owner: principal.appliedUsername,
      serviceName: service.name,
      storageName: storage.name,
    })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .leftJoin(service, eq(service.id, folder.serviceId))
    .leftJoin(storage, eq(storage.id, folder.storageId))
    .where(and(match, ne(folder.state, 'missing')))
  const deleted = new Set(scope.storageIds)
  return sortByName(rows, (row) => `${row.scope}/${row.kind}/${row.slug}`).map((row) => {
    const kind = row.kind === 'volume' ? 'volume' : 'service'
    const kept = kind === 'volume' && row.storageId !== null && !deleted.has(row.storageId)
    return {
      id: row.id,
      serverId: row.serverId,
      kind,
      path: hostPath(row.owner, row.scope, kind, row.slug),
      assetName: row.serviceName ?? row.storageName ?? null,
      action: kept ? 'keep' : 'remove',
    }
  })
}

async function loadPlanCertificates(
  db: Pick<Db, 'select'>,
  serviceIds: string[]
): Promise<SiteCertificateFate[]> {
  if (serviceIds.length === 0) return []
  const rows = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(inArray(hosting.serviceId, serviceIds))
  return await planSiteCertificates(
    db,
    rows.map((row) => row.id)
  )
}

async function loadServers(
  db: Pick<Db, 'select'>,
  serverIds: readonly string[]
): Promise<DeletePlanServer[]> {
  if (serverIds.length === 0) return []
  const rows = await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      connected: server.isConnected,
    })
    .from(server)
    .where(inArray(server.id, [...new Set(serverIds)]))
  return sortByName(rows, (row) => row.name ?? '').map((row) => ({
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    connected: row.connected === true,
  }))
}

/** What a person calls the server: its name, else its hostname; never its raw id. */
export function serverLabel(row: Pick<DeletePlanServer, 'name' | 'hostname'>): string {
  const name = row.name?.trim()
  if (name) return name
  const hostname = row.hostname?.trim()
  return hostname ? hostname : 'without a name'
}

export function offlineBlocker(offline: readonly DeletePlanServer[]): DeletePlanBlocker | null {
  if (offline.length === 0) return null
  const names = offline.map(serverLabel).join(', ')
  const one = offline.length === 1
  return {
    error: SERVER_OFFLINE_ERROR,
    message: `${one ? 'Server' : 'Servers'} ${names} ${
      one ? 'is' : 'are'
    } offline, so the services there cannot be stopped and their folders cannot be removed. Nothing was deleted. Bring ${
      one ? 'it' : 'them'
    } back online and try again, or remove ${one ? 'the server' : 'those servers'} from the panel first.`,
    serverIds: offline.map((row) => row.id),
  }
}

/**
 * The primary environment cannot go while the project has others (the last
 * environment may go). A project delete takes every environment, so never.
 */
async function primaryBlocker(
  db: Pick<Db, 'select'>,
  input: DeletePlanInput,
  environments: ReadonlyArray<{ id: string; projectId: string; isPrimary: boolean }>
): Promise<DeletePlanBlocker | null> {
  const primary = environments.find((row) => row.isPrimary)
  if (input.projectId !== undefined || !primary) return null
  const others = await db
    .select({ id: environment.id })
    .from(environment)
    .where(and(eq(environment.projectId, primary.projectId), ne(environment.id, primary.id)))
    .limit(1)
  if (others.length === 0) return null
  return {
    error: PRIMARY_ENVIRONMENT_DELETE_ERROR,
    message:
      'This is the primary environment. Make another environment primary first, or delete the whole project.',
  }
}

async function runningBlocker(db: Db, input: DeletePlanInput): Promise<DeletePlanBlocker | null> {
  if (!(await hasInProgressDeployment(db, input.environmentIds))) return null
  if (input.projectId !== undefined) {
    return { error: PROJECT_DEPLOY_RUNNING_ERROR, message: PROJECT_DEPLOY_RUNNING_MESSAGE }
  }
  return { error: ENVIRONMENT_RUNNING_ERROR, message: ENVIRONMENT_DEPLOY_RUNNING_MESSAGE }
}

/** Build the plan. Reads only. */
export async function buildDeletePlan(db: Db, input: DeletePlanInput): Promise<DeletePlan> {
  const environmentIds = [...input.environmentIds]
  const environments =
    environmentIds.length === 0
      ? []
      : await db
          .select({
            id: environment.id,
            name: environment.name,
            projectId: environment.projectId,
            isPrimary: environment.isPrimary,
          })
          .from(environment)
          .where(inArray(environment.id, environmentIds))
  const services =
    environmentIds.length === 0
      ? []
      : await db
          .select({ id: service.id, name: service.name, environmentId: service.environmentId })
          .from(service)
          .where(inArray(service.environmentId, environmentIds))
  const serviceIds = services.map((row) => row.id)
  sortByName(environments, (row) => row.name ?? '')
  sortByName(services, (row) => row.name ?? '')
  const storageIds = await listStorageIdsDeletedWith(db, {
    ...(input.projectId ? { projectIds: [input.projectId] } : {}),
    environmentIds,
    ...(serviceIds.length > 0 ? { serviceIds } : {}),
  })
  const folders = await loadPlanFolders(db, { environmentIds, serviceIds, storageIds })
  const certificates = await loadPlanCertificates(db, serviceIds)

  let hostingAccounts: DeletePlanHostingAccount[] = []
  if (input.projectId) {
    const fate = await classifyProjectPrincipals(db, input.projectId, {
      environmentIds,
      serviceIds,
      storageIds,
    })
    hostingAccounts = [
      ...fate.removed.map((row) => ({ ...row, action: 'remove' as const })),
      ...fate.kept.map((row) => ({ ...row, action: 'keep' as const })),
    ]
  }

  const removedFolderServers = folders.filter((row) => row.action === 'remove')
  const mustReach = new Set([
    ...input.stopServerIds,
    ...removedFolderServers.map((row) => row.serverId),
  ])
  const servers = await loadServers(db, [...mustReach, ...folders.map((row) => row.serverId)])

  const blockers: DeletePlanBlocker[] = []
  const add = (blocker: DeletePlanBlocker | null) => {
    if (blocker) blockers.push(blocker)
  }
  if (environmentIds.length > 0) {
    const managedRows = await db
      .select({ id: managed.id })
      .from(managed)
      .where(inArray(managed.environmentId, environmentIds))
      .limit(1)
    if (managedRows.length > 0) {
      add({ error: MANAGED_RUNTIME_PRESENT_ERROR, message: MANAGED_PRESENT_MESSAGE })
    }
    const shared = await sharedAssetsStillUsed(db, {
      ...(input.projectId ? { projectIds: [input.projectId] } : {}),
      environmentIds,
      serviceIds,
    })
    if (shared) {
      add({
        error: COMMON_ASSET_IN_USE_ERROR,
        message: textOf(shared.detail.message),
        uses: shared.detail.uses,
      })
    }
  }
  add(await primaryBlocker(db, input, environments))
  add(await runningBlocker(db, input))
  add(offlineBlocker(servers.filter((row) => mustReach.has(row.id) && !row.connected)))

  return {
    environments: environments.map(({ id, name }) => ({ id, name })),
    services,
    servers,
    folders,
    hostingAccounts,
    certificates,
    blockers,
  }
}
