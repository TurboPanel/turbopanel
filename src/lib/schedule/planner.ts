/**
 * Sticky scheduler: place `task` rows on eligible servers.
 *
 * A whole-environment pin never requires TurboFabric. A plan that would use
 * two or more servers does.
 */

import type { DesiredTaskInput } from '../db/task-records.ts'
import type { PlacementConstraint, ServiceScheduleSpec } from './interpret.ts'

export type FleetServer = {
  id: string
  connected: boolean
  labels: Record<string, string>
}

export type ExistingTask = {
  serviceId: string
  slot: number
  serverId: string
}

export type PlannedService = {
  serviceId: string
  spec: ServiceScheduleSpec
}

export type ScheduleErrorCode =
  | 'turbofabric_required'
  | 'no_eligible_server'
  | 'host_port_conflict'
  | 'constraint_unsatisfiable'
  | 'colocation_conflict'

export type SchedulePlan =
  | { ok: true; tasks: DesiredTaskInput[]; serverIds: string[] }
  | { ok: false; error: ScheduleErrorCode; message: string }

export type PlanEnvironmentInput = {
  pinServerId: string | null
  defaultServerId: string | null
  fabricEnabled: boolean
  servers: readonly FleetServer[]
  services: readonly PlannedService[]
  existingTasks: readonly ExistingTask[]
  /** Logical service id → local-storage server pin. */
  storagePins: ReadonlyMap<string, string>
}

function constraintMatches(
  labels: Record<string, string>,
  constraint: PlacementConstraint,
): boolean {
  const actual = labels[constraint.key]
  if (constraint.op === 'eq') return actual === constraint.value
  return actual !== constraint.value
}

function serverMatchesConstraints(
  server: FleetServer,
  constraints: readonly PlacementConstraint[],
): boolean {
  return constraints.every((constraint) => constraintMatches(server.labels, constraint))
}

function connectedServers(servers: readonly FleetServer[]): FleetServer[] {
  return servers.filter((row) => row.connected)
}

function findServer(
  servers: readonly FleetServer[],
  id: string | null,
): FleetServer | undefined {
  if (!id) return undefined
  return servers.find((row) => row.id === id)
}

/**
 * Online fleet plus the whole-environment pin / project default even when
 * those hosts are not yet marked connected (preview and fixture deploys do
 * not require a live daemon).
 */
function schedulingPool(
  servers: readonly FleetServer[],
  pinServerId: string | null,
  defaultServerId: string | null,
): FleetServer[] {
  const online = connectedServers(servers)
  const extras: FleetServer[] = []
  for (const id of [pinServerId, defaultServerId]) {
    const row = findServer(servers, id)
    if (!row) continue
    if (online.some((server) => server.id === row.id)) continue
    if (extras.some((server) => server.id === row.id)) continue
    extras.push(row)
  }
  return [...online, ...extras]
}

function eligibleForService(
  servers: readonly FleetServer[],
  spec: ServiceScheduleSpec,
  pinServerId: string | null,
  defaultServerId: string | null,
  storagePin: string | undefined,
): FleetServer[] {
  let pool = schedulingPool(servers, pinServerId, defaultServerId)
  if (pinServerId) {
    pool = pool.filter((row) => row.id === pinServerId)
  }
  if (storagePin) {
    pool = pool.filter((row) => row.id === storagePin)
  }
  return pool.filter((row) => serverMatchesConstraints(row, spec.constraints))
}

function existingByServiceSlot(
  existing: readonly ExistingTask[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const task of existing) {
    map.set(`${task.serviceId}:${String(task.slot)}`, task.serverId)
  }
  return map
}

function spreadScore(
  server: FleetServer,
  spreadKeys: readonly string[],
  usedLabelValues: Map<string, number>,
): number {
  let score = 0
  for (const key of spreadKeys) {
    const value = server.labels[key] ?? ''
    score += usedLabelValues.get(`${key}=${value}`) ?? 0
  }
  return score
}

function pickServer(
  eligible: readonly FleetServer[],
  spreadKeys: readonly string[],
  usedLabelValues: Map<string, number>,
  occupied: ReadonlySet<string>,
  requireEmptyHost: boolean,
  preferredId: string | null,
): FleetServer | null {
  const candidates = requireEmptyHost
    ? eligible.filter((row) => !occupied.has(row.id))
    : [...eligible]
  if (candidates.length === 0) return null
  if (!requireEmptyHost && preferredId) {
    const preferred = candidates.find((row) => row.id === preferredId)
    if (preferred) return preferred
  }
  candidates.sort((a, b) => {
    const spread = spreadScore(a, spreadKeys, usedLabelValues) -
      spreadScore(b, spreadKeys, usedLabelValues)
    if (spread !== 0) return spread
    return a.id.localeCompare(b.id)
  })
  return candidates[0] ?? null
}

function recordSpread(
  server: FleetServer,
  spreadKeys: readonly string[],
  usedLabelValues: Map<string, number>,
): void {
  for (const key of spreadKeys) {
    const token = `${key}=${server.labels[key] ?? ''}`
    usedLabelValues.set(token, (usedLabelValues.get(token) ?? 0) + 1)
  }
}

function replicaCount(spec: ServiceScheduleSpec, eligibleCount: number): number {
  if (spec.mode === 'global') return Math.max(eligibleCount, 0)
  return spec.replicas
}

function colocationGroups(services: readonly PlannedService[]): string[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const current = parent.get(id) ?? id
    if (current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }
  const nameToId = new Map(
    services.map((row) => [row.spec.composeServiceName, row.serviceId]),
  )
  for (const row of services) {
    parent.set(row.serviceId, row.serviceId)
  }
  for (const row of services) {
    for (const otherName of row.spec.colocateWith) {
      const otherId = nameToId.get(otherName)
      if (otherId) union(row.serviceId, otherId)
    }
  }
  const groups = new Map<string, string[]>()
  for (const row of services) {
    const root = find(row.serviceId)
    const list = groups.get(root) ?? []
    list.push(row.serviceId)
    groups.set(root, list)
  }
  return [...groups.values()]
}

function fail(error: ScheduleErrorCode, message: string): SchedulePlan {
  return { ok: false, error, message }
}

type GroupPlaceResult =
  | { ok: true; tasks: DesiredTaskInput[] }
  | { ok: false; error: ScheduleErrorCode; message: string }

function planEmptyEnvironment(input: PlanEnvironmentInput): SchedulePlan {
  const fallbackId = input.pinServerId ?? input.defaultServerId
  if (!fallbackId) return { ok: true, tasks: [], serverIds: [] }
  if (!findServer(input.servers, fallbackId)) {
    return fail('no_eligible_server', 'Pinned server is not in this organization')
  }
  return { ok: true, tasks: [], serverIds: [fallbackId] }
}

function missingPinnedServer(input: PlanEnvironmentInput): SchedulePlan | null {
  if (!input.pinServerId) return null
  if (findServer(input.servers, input.pinServerId)) return null
  return fail('no_eligible_server', 'Pinned server is not in this organization')
}

function intersectGroupEligible(
  pool: readonly FleetServer[],
  groupServices: readonly PlannedService[],
  input: PlanEnvironmentInput,
): FleetServer[] {
  let eligible = [...pool]
  if (input.pinServerId) {
    eligible = eligible.filter((row) => row.id === input.pinServerId)
  }
  for (const row of groupServices) {
    const next = eligibleForService(
      input.servers,
      row.spec,
      input.pinServerId,
      input.defaultServerId,
      input.storagePins.get(row.serviceId),
    )
    const allowed = new Set(next.map((server) => server.id))
    eligible = eligible.filter((server) => allowed.has(server.id))
  }
  return eligible
}

function emptyGroupError(groupServices: readonly PlannedService[]): GroupPlaceResult {
  const names = groupServices.map((row) => row.spec.composeServiceName).join(', ')
  const colocated = groupServices.some((row) => row.spec.colocateWith.length > 0)
  return fail(
    colocated ? 'colocation_conflict' : 'constraint_unsatisfiable',
    `No eligible server for ${names}`,
  )
}

function placeGroupServices(
  groupServices: readonly PlannedService[],
  eligible: FleetServer[],
  existing: Map<string, string>,
  preferredId: string | null,
): GroupPlaceResult {
  const fallback = findServer(eligible, preferredId) ?? eligible[0]
  if (!fallback) {
    return fail('no_eligible_server', 'No eligible server remains after constraints')
  }
  const hosts = eligible.length > 0 ? eligible : [fallback]
  const tasks: DesiredTaskInput[] = []
  for (const row of groupServices) {
    const placed = placeService({
      service: row,
      eligible: hosts,
      existing,
      requireEmptyHost: row.spec.publishedHostPorts.length > 0,
      preferredId,
    })
    if ('error' in placed) return fail(placed.error, placed.message)
    tasks.push(...placed.tasks)
  }
  return { ok: true, tasks }
}

function placeColocationGroup(
  group: readonly string[],
  byId: ReadonlyMap<string, PlannedService>,
  pool: readonly FleetServer[],
  existing: Map<string, string>,
  input: PlanEnvironmentInput,
): GroupPlaceResult {
  const groupServices = group
    .map((id) => byId.get(id))
    .filter((row): row is PlannedService => row !== undefined)
  const eligible = intersectGroupEligible(pool, groupServices, input)
  if (eligible.length === 0) return emptyGroupError(groupServices)
  return placeGroupServices(groupServices, eligible, existing, input.defaultServerId)
}

function fabricRequiredForServers(
  serverIds: readonly string[],
  fabricEnabled: boolean,
  pinServerId: string | null,
): boolean {
  return serverIds.length > 1 && !fabricEnabled && !pinServerId
}

function placeService(params: {
  service: PlannedService
  eligible: FleetServer[]
  existing: Map<string, string>
  requireEmptyHost: boolean
  preferredId: string | null
}): { tasks: DesiredTaskInput[] } | { error: ScheduleErrorCode; message: string } {
  const { service, eligible, existing, requireEmptyHost, preferredId } = params
  const count = replicaCount(service.spec, eligible.length)
  if (count < 1) {
    return {
      error: 'no_eligible_server',
      message: `No eligible server for ${service.spec.composeServiceName}`,
    }
  }
  if (requireEmptyHost && count > eligible.length) {
    return {
      error: 'host_port_conflict',
      message:
        `${service.spec.composeServiceName} publishes a host port and cannot ` +
        `place ${String(count)} replicas on ${String(eligible.length)} server(s)`,
    }
  }

  const usedLabelValues = new Map<string, number>()
  const occupied = new Set<string>()
  const tasks: DesiredTaskInput[] = []

  for (let slot = 0; slot < count; slot += 1) {
    const stickyId = existing.get(`${service.serviceId}:${String(slot)}`)
    const sticky = stickyId
      ? eligible.find((row) => row.id === stickyId)
      : undefined
    const chosen = sticky ?? pickServer(
      eligible,
      service.spec.spreadKeys,
      usedLabelValues,
      occupied,
      requireEmptyHost,
      preferredId,
    )
    if (!chosen) {
      return {
        error: requireEmptyHost ? 'host_port_conflict' : 'no_eligible_server',
        message: `Could not place ${service.spec.composeServiceName} slot ${String(slot)}`,
      }
    }
    occupied.add(chosen.id)
    recordSpread(chosen, service.spec.spreadKeys, usedLabelValues)
    tasks.push({
      serviceId: service.serviceId,
      serverId: chosen.id,
      slot,
      desiredState: 'running',
    })
  }
  return { tasks }
}

/**
 * Plan tasks for an environment. Callers persist via `replaceEnvironmentTasks`
 * and `upsertDeploymentTargets`.
 */
export function planEnvironmentSchedule(input: PlanEnvironmentInput): SchedulePlan {
  if (input.services.length === 0) return planEmptyEnvironment(input)

  const pool = schedulingPool(
    input.servers,
    input.pinServerId,
    input.defaultServerId,
  )
  if (pool.length === 0) {
    return fail('no_eligible_server', 'No connected servers are available')
  }

  const pinError = missingPinnedServer(input)
  if (pinError) return pinError

  const existing = existingByServiceSlot(input.existingTasks)
  const byId = new Map(input.services.map((row) => [row.serviceId, row]))
  const allTasks: DesiredTaskInput[] = []

  for (const group of colocationGroups(input.services)) {
    const placed = placeColocationGroup(group, byId, pool, existing, input)
    if (!placed.ok) return placed
    allTasks.push(...placed.tasks)
  }

  const serverIds = [...new Set(allTasks.map((task) => task.serverId))]
    .sort((a, b) => a.localeCompare(b))
  if (fabricRequiredForServers(serverIds, input.fabricEnabled, input.pinServerId)) {
    return fail(
      'turbofabric_required',
      'Enable TurboFabric to run this environment across servers',
    )
  }

  allTasks.sort((a, b) => {
    const byService = a.serviceId.localeCompare(b.serviceId)
    if (byService !== 0) return byService
    return a.slot - b.slot
  })
  return { ok: true, tasks: allTasks, serverIds }
}

export function localReplicaCounts(
  tasks: readonly DesiredTaskInput[],
  serviceIdToName: ReadonlyMap<string, string>,
  serverId: string,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (task.serverId !== serverId) continue
    const name = serviceIdToName.get(task.serviceId)
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

export function localServiceNames(
  tasks: readonly DesiredTaskInput[],
  serviceIdToName: ReadonlyMap<string, string>,
  serverId: string,
): Set<string> {
  const names = new Set<string>()
  for (const task of tasks) {
    if (task.serverId !== serverId) continue
    const name = serviceIdToName.get(task.serviceId)
    if (name) names.add(name)
  }
  return names
}
