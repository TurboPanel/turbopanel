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
  canForgetServerResources,
  listServerDeleteBlockers,
  notSystemWorkspace,
  SERVER_DELETE_PREVIEW_LIST_CAP,
  type CappedPreviewList,
  type ServerDeleteBlocker,
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

const SERVER_SERVICES_REMOVAL_COPY: Record<
  Exclude<ServerServicesRemovalKind, 'container' | 'network' | 'ip' | 'colocated'>,
  { one: string; many: string }
> = {
  environment: {
    one: 'One app environment is still placed on this server.',
    many: '%n app environments are still placed on this server.',
  },
  managed: {
    one: 'One managed database is still placed on this server.',
    many: '%n managed databases are still placed on this server.',
  },
  replica: {
    one: 'One database member is still placed on this server.',
    many: '%n database members are still placed on this server.',
  },
  deployment: {
    one: 'One deployment is still recorded on this server.',
    many: '%n deployments are still recorded on this server.',
  },
  slot: {
    one: 'One scheduled app instance is still placed on this server.',
    many: '%n scheduled app instances are still placed on this server.',
  },
  copy: {
    one: 'One volume copy is still stored on this server.',
    many: '%n volume copies are still stored on this server.',
  },
}

export function serverServicesRemovalMessage(
  kind: ServerServicesRemovalKind,
  count: number,
  opts: Readonly<{ canForget?: boolean }> = {}
): string {
  if (kind === 'colocated') {
    return 'This is the machine running the control panel itself and cannot be removed.'
  }
  if (kind === 'container') {
    if (opts.canForget) {
      return forCount(
        count,
        'One container is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
        `${count} containers are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.`
      )
    }
    return forCount(
      count,
      'One container is still on this server: stop or move the apps first.',
      `${count} containers are still on this server: stop or move the apps first.`
    )
  }
  if (kind === 'network') {
    if (opts.canForget) {
      return forCount(
        count,
        'One network is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
        `${count} networks are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.`
      )
    }
    return forCount(
      count,
      'One network is still on this server: remove it first.',
      `${count} networks are still on this server: remove them first.`
    )
  }
  if (kind === 'ip') {
    if (opts.canForget) {
      return forCount(
        count,
        'One address is still recorded on this server. Because the host is offline, you can remove it with Delete server → Host is gone.',
        `${count} addresses are still recorded on this server. Because the host is offline, you can remove them with Delete server → Host is gone.`
      )
    }
    return forCount(
      count,
      'One address is still assigned to this server: remove it first.',
      `${count} addresses are still assigned to this server: remove them first.`
    )
  }
  const copy = SERVER_SERVICES_REMOVAL_COPY[kind]
  return forCount(count, copy.one, copy.many.replaceAll('%n', String(count)))
}

export function serverServicesRemovalReasons(
  blockers: ServerDeleteBlocker[],
  colocated: boolean,
  canForget = false
): ServerServicesRemovalReason[] {
  const reasons: ServerServicesRemovalReason[] = []
  if (colocated) {
    reasons.push({
      kind: 'colocated',
      count: 1,
      message: serverServicesRemovalMessage('colocated', 1),
    })
  }
  for (const blocker of blockers) {
    reasons.push({
      kind: blocker.kind,
      count: blocker.count,
      message: serverServicesRemovalMessage(blocker.kind, blocker.count, { canForget }),
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
    blockers,
    colocatedIds,
    colocatedLicense,
    appRows,
    databases,
    databaseUsers,
    backups,
    networkRows,
    [ipCountRow],
  ] = await Promise.all([
    listServerDeleteBlockers(db, serverId, organizationId),
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
  const canForget = canForgetServerResources({ online, colocated, blockers })
  const reasons = serverServicesRemovalReasons(blockers, colocated, canForget)
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
