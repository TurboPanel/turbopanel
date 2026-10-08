import { count, eq, inArray, max } from 'drizzle-orm'
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
} from '../../db/schema.ts'
import { parseServerRuntimeMetadata } from '../../features/servers/server-metadata.ts'
import {
  colocatedServerDeleteBlockedReason,
  listServerDeleteBlockers,
  type ServerDeleteBlocker,
  type ServerDeleteBlockerKind,
} from './delete-guards.ts'
import { hasActiveColocatedLicenseBinding, resolveColocatedServerIdSet } from './colocated.ts'

export type ServerServicesRemovalKind = ServerDeleteBlockerKind | 'colocated'

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
  containers: ServerServicesAppContainer[]
  domains: string[]
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
  databaseName: string
  databaseServiceName: string
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

export type ServerServicesHostService = {
  key: string
  label: string
  state: 'up' | 'down' | 'unknown'
}

export type ServerServicesRuntime = {
  kind: string
  versions: string[]
}

export type ServerServicesResponse = {
  serverId: string
  removal: {
    canRemove: boolean
    reasons: ServerServicesRemovalReason[]
  }
  apps: ServerServicesApp[]
  databases: ServerServicesDatabase[]
  databaseUsers: ServerServicesDatabaseUser[]
  backups: ServerServicesBackup[]
  networks: ServerServicesNetwork[]
  ipCount: number
  hostServices: ServerServicesHostService[]
  runtimes: ServerServicesRuntime[]
}

export function serverServicesRemovalMessage(
  kind: ServerServicesRemovalKind,
  count: number,
  label: string
): string {
  switch (kind) {
    case 'container':
      if (count === 1) {
        return '1 container still runs here: stop or move the apps first'
      }
      return `${count} containers still run here: stop or move the apps first`
    case 'network':
      if (count === 1) {
        return '1 network still uses this server: remove it first'
      }
      return `${count} networks still use this server: remove them first`
    case 'ip':
      if (count === 1) {
        return '1 address is still assigned here: remove it first'
      }
      return `${count} addresses are still assigned here: remove them first`
    case 'colocated':
      return colocatedServerDeleteBlockedReason()
    default:
      return count > 1
        ? `Still on this server: ${label} (${count})`
        : `Still on this server: ${label}`
  }
}

export function serverServicesRemovalReasons(
  blockers: ServerDeleteBlocker[],
  colocated: boolean
): ServerServicesRemovalReason[] {
  const reasons: ServerServicesRemovalReason[] = []
  if (colocated) {
    reasons.push({
      kind: 'colocated',
      count: 1,
      message: serverServicesRemovalMessage('colocated', 1, ''),
    })
  }
  for (const blocker of blockers) {
    reasons.push({
      kind: blocker.kind,
      count: blocker.count,
      message: serverServicesRemovalMessage(blocker.kind, blocker.count, blocker.label),
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
      containers: app.containers,
      domains: domainsByService.get(serviceId) ?? [],
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
    .where(eq(container.serverId, serverId))
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
    .where(eq(replica.serverId, serverId))
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
    .selectDistinct({
      serviceId: binding.serviceId,
      serviceName: service.name,
      composeServiceName: service.composeServiceName,
      databaseName: binding.databaseName,
      managedName: managed.name,
      engine: managed.engine,
    })
    .from(binding)
    .innerJoin(service, eq(service.id, binding.serviceId))
    .innerJoin(container, eq(container.serviceId, service.id))
    .innerJoin(principal, eq(principal.id, binding.principalId))
    .innerJoin(managed, eq(managed.id, principal.managedId))
    .where(eq(container.serverId, serverId))
  const users = rows.map((row) => ({
    serviceId: row.serviceId,
    serviceName: row.serviceName ?? row.composeServiceName,
    databaseName: row.databaseName,
    databaseServiceName: row.managedName ?? row.engine,
  }))
  users.sort((a, b) => {
    const serviceCmp = compareName(a.serviceName, b.serviceName)
    if (serviceCmp !== 0) return serviceCmp
    return compareName(a.databaseName, b.databaseName)
  })
  return users
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
    .innerJoin(replica, eq(replica.managedId, managed.id))
    .where(eq(replica.serverId, serverId))
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
  metadata: unknown
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
  const reasons = serverServicesRemovalReasons(blockers, colocated)
  const networks = networkRows
    .map((row) => ({ id: row.id, name: row.name ?? '', kind: row.kind }))
    .sort((a, b) => compareName(a.name, b.name) || compareName(a.id, b.id))

  return {
    serverId,
    removal: { canRemove: reasons.length === 0, reasons },
    apps: groupApps(appRows, domainsByService),
    databases,
    databaseUsers,
    backups,
    networks,
    ipCount: Number(ipCountRow?.value ?? 0),
    hostServices: [],
    runtimes: serverServicesRuntimesFromMetadata(metadata),
  }
}
