import { and, count, eq, inArray, max, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import {
  backup,
  binding,
  container,
  environment,
  hostname,
  hosting,
  ip,
  managed,
  network,
  principal,
  project,
  replica,
  service,
  workspace,
} from '../../db/schema.ts'
import { parseServerRuntimeMetadata } from '../../features/servers/server-metadata.ts'
import {
  blockedDatabaseForgetMessage,
  canForgetServerResources,
  notSystemWorkspace,
  planServerForget,
  serverBlockerItemName,
  SERVER_DELETE_PREVIEW_LIST_CAP,
  type CappedPreviewList,
  type ServerDeleteBlocker,
  type ServerDeleteBlockerItem,
  type ServerForgetBlockedDatabase,
  type ServerServicesRemovalKind,
} from './delete-guards.ts'
import { hasActiveColocatedLicenseBinding, resolveColocatedServerIdSet } from './colocated.ts'

export type { ServerServicesRemovalKind }
export { SERVER_SERVICES_REMOVAL_KIND_VALUES } from './delete-guards.ts'

/** Shared with delete-preview leftover lists. */
export const SERVER_SERVICES_LIST_CAP = SERVER_DELETE_PREVIEW_LIST_CAP

export type ServerServicesCappedList<T> = CappedPreviewList<T>

export type ServerServicesRemovalReason = {
  kind: ServerServicesRemovalKind
  count: number
  message: string
  /** Named rows behind this reason (see `ServerDeleteBlocker.items`). */
  items?: ServerDeleteBlockerItem[]
  more?: number
}

export type ServerServicesAppContainer = {
  name: string
  status: string
  role: string
}

export type ServerServicesApp = {
  serviceId: string
  name: string
  project: string
  environment: string
  containers: ServerServicesCappedList<ServerServicesAppContainer>
  domains: ServerServicesCappedList<string>
}

export type ServerServicesDatabase = {
  managedId: string
  name: string
  engine: string
  role: 'primary' | 'replica'
  status: string
  readEligible: boolean
  ordinal: number
}

export type ServerServicesDatabaseUser = {
  serviceId: string
  serviceName: string
  databases: string[]
}

export type ServerServicesBackup = {
  managedId: string
  managedName: string
  count: number
  latestAt: string
}

export type ServerServicesNetwork = {
  id: string
  name: string
  kind: string
}

export type ServerServicesRuntime = {
  kind: string
  versions: string[]
}

export type ServerServicesResponse = {
  serverId: string
  removal: {
    canRemove: boolean
    online: boolean
    canForget: boolean
    reasons: ServerServicesRemovalReason[]
  }
  apps: ServerServicesCappedList<ServerServicesApp>
  databases: ServerServicesDatabase[]
  databaseUsers: ServerServicesCappedList<ServerServicesDatabaseUser>
  backups: ServerServicesCappedList<ServerServicesBackup>
  networks: ServerServicesCappedList<ServerServicesNetwork>
  ipCount: number
  runtimes: ServerServicesRuntime[]
}

export function capServerServicesList<T>(
  items: T[],
  cap = SERVER_SERVICES_LIST_CAP
): ServerServicesCappedList<T> {
  const capped = items.slice(0, cap)
  return {
    items: capped,
    more: Math.max(0, items.length - capped.length),
  }
}

function forCount(count: number, one: string, many: string): string {
  if (count === 1) return one
  return many
}

type ServerServicesRemovalCountTemplates = {
  one: string
  many: string
  forgettableOne?: string
  forgettableMany?: string
}

const SERVER_SERVICES_REMOVAL_TEMPLATES: Record<
  Exclude<ServerServicesRemovalKind, 'colocated'>,
  ServerServicesRemovalCountTemplates
> = {
  environment: {
    one: 'One app environment is still placed on this server.',
    many: '%n app environments are still placed on this server.',
    forgettableOne:
      'One app environment lived only on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n app environments lived only on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
  container: {
    one: 'One container is still on this server: stop or move the apps first.',
    many: '%n containers are still on this server: stop or move the apps first.',
    forgettableOne:
      'One container is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n containers are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
  network: {
    one: 'One network is still on this server: remove it first.',
    many: '%n networks are still on this server: remove them first.',
    forgettableOne:
      'One network is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n networks are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
  ip: {
    one: 'One address is still assigned to this server: remove it first.',
    many: '%n addresses are still assigned to this server: remove them first.',
    forgettableOne:
      'One address is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n addresses are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
  managed: {
    one: 'One managed database is still placed on this server.',
    many: '%n managed databases are still placed on this server.',
  },
  replica: {
    one: 'One database member is still placed on this server.',
    many: '%n database members are still placed on this server.',
    forgettableOne:
      'One database member is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n database members are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
  deployment: {
    one: 'One deployment is still recorded on this server.',
    many: '%n deployments are still recorded on this server.',
    forgettableOne:
      'One deployment is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n deployments are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
  slot: {
    one: 'One scheduled app instance is still placed on this server.',
    many: '%n scheduled app instances are still placed on this server.',
    forgettableOne:
      'One scheduled app instance is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n scheduled app instances are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
  copy: {
    one: 'One volume copy is still stored on this server.',
    many: '%n volume copies are still stored on this server.',
    forgettableOne:
      'One volume copy is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
    forgettableMany:
      '%n volume copies are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
  },
}

/** How many names a reason sentence spells out before it says "and N more". */
export const SERVER_SERVICES_REMOVAL_NAME_LIMIT = 3

type NamedRemovalCopy = { one: string; many: string }

/**
 * Reason copy that names the rows (`%s`). The owner cannot act on "3 app
 * environments" without knowing which ones, so these replace the counted
 * sentences whenever the blocker carries items.
 */
const SERVER_SERVICES_REMOVAL_NAMED_COPY: Partial<
  Record<ServerServicesRemovalKind, { placed: NamedRemovalCopy; forgettable?: NamedRemovalCopy }>
> = {
  environment: {
    placed: {
      one: 'App environment %s is still placed on this server.',
      many: 'App environments %s are still placed on this server.',
    },
    forgettable: {
      one: 'App environment %s lived only on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
      many: 'App environments %s lived only on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
    },
  },
  // A database placed here always blocks forget, so there is no Host is gone
  // variant to offer.
  managed: {
    placed: {
      one: 'Managed database %s is still placed on this server.',
      many: 'Managed databases %s are still placed on this server.',
    },
  },
  replica: {
    placed: {
      one: 'Database %s still has a member on this server.',
      many: 'Databases %s still have members on this server.',
    },
    forgettable: {
      one: 'Database %s still has a member recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
      many: 'Databases %s still have members recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.',
    },
  },
}

function joinNames(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** Up to three quoted names, then "and N more". */
export function serverServicesRemovalNames(
  items: readonly ServerDeleteBlockerItem[],
  more = 0
): string {
  const shown = items
    .slice(0, SERVER_SERVICES_REMOVAL_NAME_LIMIT)
    .map((item) => `"${serverBlockerItemName(item)}"`)
  const hidden = items.length - shown.length + more
  if (hidden > 0) shown.push(`${hidden} more`)
  return joinNames(shown)
}

function namedRemovalMessage(
  kind: ServerServicesRemovalKind,
  items: readonly ServerDeleteBlockerItem[],
  more: number,
  canForget: boolean
): string | null {
  const copy = SERVER_SERVICES_REMOVAL_NAMED_COPY[kind]
  if (!copy || items.length === 0) return null
  const template = (canForget ? copy.forgettable : undefined) ?? copy.placed
  const sentence = items.length + more === 1 ? template.one : template.many
  return sentence.replace('%s', serverServicesRemovalNames(items, more))
}

function serverServicesRemovalCountMessage(
  templates: ServerServicesRemovalCountTemplates,
  count: number,
  canForget: boolean,
  kind: ServerServicesRemovalKind
): string {
  const useForgettable = canForget && kind !== 'managed' && templates.forgettableOne !== undefined
  if (useForgettable) {
    return forCount(
      count,
      templates.forgettableOne!,
      templates.forgettableMany!.replaceAll('%n', String(count))
    )
  }
  return forCount(count, templates.one, templates.many.replaceAll('%n', String(count)))
}

export function serverServicesRemovalMessage(
  kind: ServerServicesRemovalKind,
  count: number,
  opts: Readonly<{
    canForget?: boolean
    items?: readonly ServerDeleteBlockerItem[]
    more?: number
  }> = {}
): string {
  if (kind === 'colocated') {
    return 'This is the machine running the control panel itself and cannot be removed.'
  }
  const named = namedRemovalMessage(kind, opts.items ?? [], opts.more ?? 0, opts.canForget === true)
  if (named) return named
  return serverServicesRemovalCountMessage(
    SERVER_SERVICES_REMOVAL_TEMPLATES[kind],
    count,
    opts.canForget === true,
    kind
  )
}

export function serverServicesRemovalReasons(
  blockers: ServerDeleteBlocker[],
  colocated: boolean,
  canForget = false,
  blockedDatabases: readonly ServerForgetBlockedDatabase[] = []
): ServerServicesRemovalReason[] {
  const reasons: ServerServicesRemovalReason[] = []
  if (colocated) {
    reasons.push({
      kind: 'colocated',
      count: 1,
      message: serverServicesRemovalMessage('colocated', 1),
    })
  }
  const skipManagedKinds = blockedDatabases.length > 0
  for (const blocker of blockers) {
    if (skipManagedKinds && (blocker.kind === 'managed' || blocker.kind === 'replica')) {
      continue
    }
    const items = blocker.items ?? []
    const more = blocker.more ?? 0
    reasons.push({
      kind: blocker.kind,
      count: blocker.count,
      message: serverServicesRemovalMessage(blocker.kind, blocker.count, {
        canForget,
        items,
        more,
      }),
      ...(items.length > 0 ? { items, more } : {}),
    })
  }
  for (const database of blockedDatabases) {
    reasons.push({
      kind: database.reason === 'primary_here' ? 'replica' : 'managed',
      count: 1,
      message: blockedDatabaseForgetMessage(database.name, database.reason),
      items: [{ id: database.id, name: database.name }],
      more: 0,
    })
  }
  return reasons
}

export function serverServicesRuntimesFromMetadata(metadata: unknown): ServerServicesRuntime[] {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return []
  }
  const parsed = parseServerRuntimeMetadata((metadata as { runtimes?: unknown }).runtimes)
  if (!parsed) return []
  const runtimes: ServerServicesRuntime[] = []
  if (parsed.php) runtimes.push({ kind: 'php', versions: parsed.php.series })
  if (parsed.node) runtimes.push({ kind: 'node', versions: parsed.node.series })
  if (parsed.lsphp) runtimes.push({ kind: 'lsphp', versions: parsed.lsphp.series })
  return runtimes
}

function compareName(a: string, b: string): number {
  return a.localeCompare(b)
}

function replicaRole(value: string): 'primary' | 'replica' {
  return value === 'replica' ? 'replica' : 'primary'
}

function groupApps(
  rows: Array<{
    serviceId: string
    serviceName: string | null
    composeServiceName: string
    projectName: string | null
    environmentName: string | null
    containerName: string
    containerStatus: string
    containerRole: string
  }>,
  domainsByService: Map<string, string[]>
): ServerServicesApp[] {
  const byService = new Map<
    string,
    {
      name: string
      project: string
      environment: string
      containers: ServerServicesAppContainer[]
    }
  >()
  for (const row of rows) {
    let app = byService.get(row.serviceId)
    if (!app) {
      app = {
        name: row.serviceName ?? row.composeServiceName,
        project: row.projectName ?? '',
        environment: row.environmentName ?? '',
        containers: [],
      }
      byService.set(row.serviceId, app)
    }
    app.containers.push({
      name: row.containerName,
      status: row.containerStatus,
      role: row.containerRole,
    })
  }
  const apps: ServerServicesApp[] = []
  for (const [serviceId, app] of byService) {
    app.containers.sort((a, b) => compareName(a.name, b.name))
    apps.push({
      serviceId,
      name: app.name,
      project: app.project,
      environment: app.environment,
      containers: capServerServicesList(app.containers),
      domains: capServerServicesList(domainsByService.get(serviceId) ?? []),
    })
  }
  apps.sort((a, b) => {
    const projectCmp = compareName(a.project, b.project)
    if (projectCmp !== 0) return projectCmp
    const envCmp = compareName(a.environment, b.environment)
    if (envCmp !== 0) return envCmp
    return compareName(a.name, b.name)
  })
  return apps
}

function groupDatabaseUsers(
  rows: Array<{
    serviceId: string
    serviceName: string | null
    composeServiceName: string
    databaseName: string
  }>
): ServerServicesDatabaseUser[] {
  const byService = new Map<string, { serviceName: string; databases: string[] }>()
  for (const row of rows) {
    const serviceName = row.serviceName ?? row.composeServiceName
    let entry = byService.get(row.serviceId)
    if (!entry) {
      entry = { serviceName, databases: [] }
      byService.set(row.serviceId, entry)
    }
    if (!entry.databases.includes(row.databaseName)) {
      entry.databases.push(row.databaseName)
    }
  }
  const users: ServerServicesDatabaseUser[] = []
  for (const [serviceId, entry] of byService) {
    entry.databases.sort((a, b) => compareName(a, b))
    users.push({
      serviceId,
      serviceName: entry.serviceName,
      databases: entry.databases,
    })
  }
  users.sort((a, b) => compareName(a.serviceName, b.serviceName))
  return users
}

function loadAppRows(db: Db, serverId: string) {
  return db
    .select({
      serviceId: service.id,
      serviceName: service.name,
      composeServiceName: service.composeServiceName,
      projectName: project.name,
      environmentName: environment.name,
      containerName: container.containerName,
      containerStatus: container.status,
      containerRole: container.role,
    })
    .from(container)
    .innerJoin(service, eq(service.id, container.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(and(eq(container.serverId, serverId), notSystemWorkspace()))
}

async function loadDomainsByService(db: Db, serviceIds: string[]): Promise<Map<string, string[]>> {
  const domainsByService = new Map<string, string[]>()
  if (serviceIds.length === 0) return domainsByService
  const rows = await db
    .select({
      serviceId: hosting.serviceId,
      hostname: hostname.hostname,
    })
    .from(hostname)
    .innerJoin(hosting, eq(hosting.id, hostname.hostingId))
    .where(inArray(hosting.serviceId, serviceIds))
  for (const row of rows) {
    const list = domainsByService.get(row.serviceId) ?? []
    list.push(row.hostname)
    domainsByService.set(row.serviceId, list)
  }
  for (const list of domainsByService.values()) {
    list.sort((a, b) => compareName(a, b))
  }
  return domainsByService
}

async function loadDatabaseRows(db: Db, serverId: string): Promise<ServerServicesDatabase[]> {
  const rows = await db
    .select({
      managedId: replica.managedId,
      name: managed.name,
      engine: managed.engine,
      role: replica.role,
      status: replica.status,
      readEligible: replica.isReadEligible,
      ordinal: replica.ordinal,
    })
    .from(replica)
    .innerJoin(managed, eq(managed.id, replica.managedId))
    .innerJoin(environment, eq(environment.id, managed.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(and(eq(replica.serverId, serverId), notSystemWorkspace()))
  const databases = rows.map((row) => ({
    managedId: row.managedId,
    name: row.name ?? row.engine,
    engine: row.engine,
    role: replicaRole(row.role),
    status: row.status ?? '',
    readEligible: row.readEligible,
    ordinal: row.ordinal,
  }))
  databases.sort((a, b) => {
    const nameCmp = compareName(a.name, b.name)
    if (nameCmp !== 0) return nameCmp
    return a.ordinal - b.ordinal
  })
  return databases
}

async function loadDatabaseUserRows(
  db: Db,
  serverId: string
): Promise<ServerServicesDatabaseUser[]> {
  const rows = await db
    .select({
      serviceId: binding.serviceId,
      serviceName: service.name,
      composeServiceName: service.composeServiceName,
      databaseName: binding.databaseName,
    })
    .from(binding)
    .innerJoin(service, eq(service.id, binding.serviceId))
    .innerJoin(container, eq(container.serviceId, service.id))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .innerJoin(principal, eq(principal.id, binding.principalId))
    .innerJoin(managed, eq(managed.id, principal.managedId))
    .where(and(eq(container.serverId, serverId), notSystemWorkspace()))
  return groupDatabaseUsers(rows)
}

async function loadBackupRows(db: Db, serverId: string): Promise<ServerServicesBackup[]> {
  const rows = await db
    .select({
      managedId: backup.managedId,
      managedName: managed.name,
      engine: managed.engine,
      count: count(),
      latestAt: max(backup.createdAt),
    })
    .from(backup)
    .innerJoin(managed, eq(managed.id, backup.managedId))
    .innerJoin(environment, eq(environment.id, managed.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .innerJoin(workspace, eq(workspace.id, project.workspaceId))
    .where(
      and(
        notSystemWorkspace(),
        sql`EXISTS (
          SELECT 1
          FROM replica AS member
          WHERE member.managed_id = ${managed.id}
            AND member.server_id = ${serverId}::uuid
        )`
      )
    )
    .groupBy(backup.managedId, managed.name, managed.engine)
  const backups = rows
    .filter((row) => row.latestAt)
    .map((row) => ({
      managedId: row.managedId,
      managedName: row.managedName ?? row.engine,
      count: Number(row.count),
      latestAt: row.latestAt as string,
    }))
  backups.sort((a, b) => compareName(a.managedName, b.managedName))
  return backups
}

export async function loadServerServices(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverId: string,
  organizationId: string,
  metadata: unknown,
  online: boolean
): Promise<ServerServicesResponse> {
  const [
    plan,
    colocatedIds,
    colocatedLicense,
    appRows,
    databases,
    databaseUsers,
    backups,
    networkRows,
    [ipCountRow],
  ] = await Promise.all([
    planServerForget(db, serverId, organizationId),
    resolveColocatedServerIdSet(db, registry, [serverId], { includeSelfHostPin: true }),
    hasActiveColocatedLicenseBinding(db, organizationId, serverId),
    loadAppRows(db, serverId),
    loadDatabaseRows(db, serverId),
    loadDatabaseUserRows(db, serverId),
    loadBackupRows(db, serverId),
    db
      .select({ id: network.id, name: network.name, kind: network.kind })
      .from(network)
      .where(eq(network.serverId, serverId)),
    db.select({ value: count() }).from(ip).where(eq(ip.serverId, serverId)),
  ])

  const serviceIds = [...new Set(appRows.map((row) => row.serviceId))]
  const domainsByService = await loadDomainsByService(db, serviceIds)
  const colocated = colocatedIds.has(serverId) || colocatedLicense
  const canForget = canForgetServerResources({
    online,
    colocated,
    blockedDatabaseCount: plan.blockedDatabases.length,
  })
  const reasons = serverServicesRemovalReasons(
    plan.blockers,
    colocated,
    canForget,
    plan.blockedDatabases
  )
  const networks = networkRows
    .map((row) => ({ id: row.id, name: row.name ?? '', kind: row.kind }))
    .sort((a, b) => compareName(a.name, b.name) || compareName(a.id, b.id))

  return {
    serverId,
    removal: {
      canRemove: reasons.length === 0,
      online,
      canForget,
      reasons,
    },
    apps: capServerServicesList(groupApps(appRows, domainsByService)),
    databases,
    databaseUsers: capServerServicesList(databaseUsers),
    backups: capServerServicesList(backups),
    networks: capServerServicesList(networks),
    ipCount: Number(ipCountRow?.value ?? 0),
    runtimes: serverServicesRuntimesFromMetadata(metadata),
  }
}
