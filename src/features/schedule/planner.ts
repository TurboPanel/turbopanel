/**
 * Sticky scheduler: place `task` rows on eligible servers.
 *
 * A whole-environment pin never requires TurboFabric. Spanning more than one
 * server requires it only when the merged document *asked* for a network that
 * spans: server count alone no longer decides. `driver: overlay` on a top-level
 * `networks:` entry is the authored signal (`../fabric/spanning.ts`), so a
 * bridge/default-only document scheduled across two hosts gets two ordinary
 * local bridges and deploys, while a document that declares an overlay network
 * whose members land on two hosts is refused with `turbofabric_required` until
 * the organization enables the fabric — unless every pair of servers on that
 * network shares a trusted datacenter network (`pairSharesTrustedLan`): such a
 * network rides the LAN and needs no TurboFabric at all.
 *
 * Three independent things can empty a candidate list, and each has its own
 * {@link ScheduleErrorCode} because each sends the operator somewhere else:
 * placement constraints (labels, connectivity, storage pins), a published host
 * port that only one replica per host can hold, and
 * `deploy.placement.max_replicas_per_node`, the density cap this module
 * enforces per service.
 *
 * `deploy.resources.reservations` never reaches this module: the platform has no
 * per-host capacity inventory to admit against, so the field is refused at
 * deploy time by `../compose/field-policy.ts` rather than parsed and ignored.
 *
 * ## Where the project default server sits in the ordering
 *
 * `PlanEnvironmentInput.defaultServerId` is a **preference**, not a
 * restriction. {@link pickServer} scores every remaining candidate by
 * `placement.preferences` spread first and only uses the default server to
 * break a tie, so a service that authored `preferences: [{ spread: ... }]`
 * spreads even in a project that has a default server. Only
 * `pinServerId` — the whole-environment pin — restricts the candidate pool
 * itself, because that one *is* an operator instruction about where the
 * environment runs rather than a hint about where to start.
 */

import type { DesiredSlotInput } from '../servers/slot-records.ts'
import type { ComposeDocument } from '../compose/types.ts'
import {
  collectSpanningComposeNetworkKeys,
  participatingServerIdsForNetwork,
} from '../fabric/spanning.ts'
import type { PlacementConstraint, ServiceScheduleSpec } from './interpret.ts'

export type FleetServer = {
  id: string
  connected: boolean
  labels: Record<string, string>
  /** Display name for messages; falls back to the id. */
  name?: string
  /** TurboFabric membership switch; absent reads as on. */
  fabricEnabled?: boolean
}

export type ExistingSlot = {
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
  /**
   * The replica count cannot be spread within
   * `deploy.placement.max_replicas_per_node`, even using every eligible server.
   *
   * Its own code rather than `no_eligible_server` / `host_port_conflict`: every
   * host the constraints allow is genuinely available and the ports are free —
   * the arithmetic is what fails, and an operator told "no eligible server"
   * would go looking at labels and connectivity instead of at the cap or the
   * replica count.
   */
  | 'max_replicas_per_node_exceeded'

export type SchedulePlan =
  | { ok: true; slots: DesiredSlotInput[]; serverIds: string[] }
  | { ok: false; error: ScheduleErrorCode; message: string }

export type PlanEnvironmentInput = {
  pinServerId: string | null
  defaultServerId: string | null
  fabricEnabled: boolean
  servers: readonly FleetServer[]
  services: readonly PlannedService[]
  existingTasks: readonly ExistingSlot[]
  /** Logical service id → local-storage server pin. */
  storagePins: ReadonlyMap<string, string>
  /**
   * Merged compose document, when the caller has one.
   *
   * Read for one thing only: which top-level `networks:` entries the author
   * declared `driver: overlay`. That is what decides `turbofabric_required` —
   * a multi-server plan is refused only when an overlay-declared network would
   * actually span the participating servers, never for the server count on its
   * own.
   *
   * Optional because a caller with no document has, by definition, no authored
   * `networks:` block and therefore no spanning intent to honour; such a plan
   * behaves exactly like a bridge/default-only one and never requires the
   * fabric.
   */
  document?: ComposeDocument
  /**
   * The pair rule: the two servers share a trusted datacenter network and
   * both daemons route container ranges over it, so their traffic needs no
   * tunnel. Absent: no pair does (every span needs TurboFabric, as before).
   */
  pairSharesTrustedLan?: (a: string, b: string) => boolean
  /**
   * A direct TurboFabric path exists between the two servers (either way).
   * Read only for a network that mixes LAN pairs with remote ones. Absent:
   * every pair has one.
   */
  pairHasDirectTunnel?: (a: string, b: string) => boolean
}

function constraintMatches(
  labels: Record<string, string>,
  constraint: PlacementConstraint
): boolean {
  const actual = labels[constraint.key]
  if (constraint.op === 'eq') return actual === constraint.value
  return actual !== constraint.value
}

function serverMatchesConstraints(
  server: FleetServer,
  constraints: readonly PlacementConstraint[]
): boolean {
  return constraints.every((constraint) => constraintMatches(server.labels, constraint))
}

function connectedServers(servers: readonly FleetServer[]): FleetServer[] {
  return servers.filter((row) => row.connected)
}

function findServer(servers: readonly FleetServer[], id: string | null): FleetServer | undefined {
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
  defaultServerId: string | null
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
  storagePin: string | undefined
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

function existingByServiceSlot(existing: readonly ExistingSlot[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const task of existing) {
    map.set(`${task.serviceId}:${String(task.slot)}`, task.serverId)
  }
  return map
}

function spreadScore(
  server: FleetServer,
  spreadKeys: readonly string[],
  usedLabelValues: Map<string, number>
): number {
  let score = 0
  for (const key of spreadKeys) {
    const value = server.labels[key] ?? ''
    score += usedLabelValues.get(`${key}=${value}`) ?? 0
  }
  return score
}

/**
 * Hosts that have not yet reached `max_replicas_per_node` for this service.
 *
 * Independent of {@link pickServer}'s `requireEmptyHost` filter, and applied
 * alongside it: a published host port means "at most one replica here" for a
 * *port* reason, while the cap means "at most N here" for a *density* reason,
 * and a service can be subject to both at once.
 */
function withCapacityRemaining(
  candidates: readonly FleetServer[],
  perNodeCounts: ReadonlyMap<string, number>,
  maxReplicasPerNode: number | null
): FleetServer[] {
  if (maxReplicasPerNode === null) return [...candidates]
  return candidates.filter((row) => (perNodeCounts.get(row.id) ?? 0) < maxReplicasPerNode)
}

function pickServer(params: {
  eligible: readonly FleetServer[]
  spreadKeys: readonly string[]
  usedLabelValues: Map<string, number>
  occupied: ReadonlySet<string>
  requireEmptyHost: boolean
  preferredId: string | null
  perNodeCounts: ReadonlyMap<string, number>
  maxReplicasPerNode: number | null
}): FleetServer | null {
  const {
    eligible,
    spreadKeys,
    usedLabelValues,
    occupied,
    requireEmptyHost,
    preferredId,
    perNodeCounts,
    maxReplicasPerNode,
  } = params
  const withPortRoom = requireEmptyHost
    ? eligible.filter((row) => !occupied.has(row.id))
    : [...eligible]
  const candidates = withCapacityRemaining(withPortRoom, perNodeCounts, maxReplicasPerNode)
  if (candidates.length === 0) return null
  // `preferredId` is the **last** thing consulted, not the first. Returning it
  // outright is what used to make `placement.preferences` inert for every
  // project with a default server: the spread score was computed and then never
  // reached. As a tie-break it still does the job it was added for — with no
  // spread keys every candidate scores 0, so the default server wins and
  // replicas keep packing onto it — while a document that asked to spread
  // actually spreads.
  candidates.sort((a, b) => {
    const spread =
      spreadScore(a, spreadKeys, usedLabelValues) - spreadScore(b, spreadKeys, usedLabelValues)
    if (spread !== 0) return spread
    const preference = (a.id === preferredId ? 0 : 1) - (b.id === preferredId ? 0 : 1)
    if (preference !== 0) return preference
    return a.id.localeCompare(b.id)
  })
  return candidates[0] ?? null
}

function recordSpread(
  server: FleetServer,
  spreadKeys: readonly string[],
  usedLabelValues: Map<string, number>
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
  const nameToId = new Map(services.map((row) => [row.spec.composeServiceName, row.serviceId]))
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
  { ok: true; slots: DesiredSlotInput[] } | { ok: false; error: ScheduleErrorCode; message: string }

function planEmptyEnvironment(input: PlanEnvironmentInput): SchedulePlan {
  const fallbackId = input.pinServerId ?? input.defaultServerId
  if (!fallbackId) return { ok: true, slots: [], serverIds: [] }
  if (!findServer(input.servers, fallbackId)) {
    return fail('no_eligible_server', 'Pinned server is not in this organization')
  }
  return { ok: true, slots: [], serverIds: [fallbackId] }
}

function missingPinnedServer(input: PlanEnvironmentInput): SchedulePlan | null {
  if (!input.pinServerId) return null
  if (findServer(input.servers, input.pinServerId)) return null
  return fail('no_eligible_server', 'Pinned server is not in this organization')
}

function intersectGroupEligible(
  pool: readonly FleetServer[],
  groupServices: readonly PlannedService[],
  input: PlanEnvironmentInput
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
      input.storagePins.get(row.serviceId)
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
    `No eligible server for ${names}`
  )
}

function placeGroupServices(
  groupServices: readonly PlannedService[],
  eligible: FleetServer[],
  existing: Map<string, string>,
  preferredId: string | null
): GroupPlaceResult {
  const fallback = findServer(eligible, preferredId) ?? eligible[0]
  if (!fallback) {
    return fail('no_eligible_server', 'No eligible server remains after constraints')
  }
  const hosts = eligible.length > 0 ? eligible : [fallback]
  const slots: DesiredSlotInput[] = []
  for (const row of groupServices) {
    const placed = placeService({
      service: row,
      eligible: hosts,
      existing,
      requireEmptyHost: row.spec.publishedHostPorts.length > 0,
      preferredId,
    })
    if ('error' in placed) return fail(placed.error, placed.message)
    slots.push(...placed.slots)
  }
  return { ok: true, slots }
}

function placeColocationGroup(
  group: readonly string[],
  byId: ReadonlyMap<string, PlannedService>,
  pool: readonly FleetServer[],
  existing: Map<string, string>,
  input: PlanEnvironmentInput
): GroupPlaceResult {
  const groupServices = group
    .map((id) => byId.get(id))
    .filter((row): row is PlannedService => row !== undefined)
  const eligible = intersectGroupEligible(pool, groupServices, input)
  if (eligible.length === 0) return emptyGroupError(groupServices)
  return placeGroupServices(groupServices, eligible, existing, input.defaultServerId)
}

/**
 * The networks this plan spans across servers, each with its participating
 * servers.
 *
 * Authored intent decides, not arithmetic. Landing on two hosts is only a
 * problem when the document declared a `driver: overlay` network whose member
 * services (and the implicit `default`, when the document declares *that*
 * overlay) are among the hosts the plan just spread across — the same rule
 * `../fabric/spanning.ts` uses to decide which networks become `tpn_*` routed
 * bridges. A bridge/default-only document gets one ordinary local bridge per
 * host and needs no fabric to do it.
 *
 * A whole-environment pin short-circuits ahead of all of that: everything lands
 * on one host, so nothing spans.
 */
function spanningNetworksForPlan(
  input: PlanEnvironmentInput,
  slots: readonly DesiredSlotInput[],
  serverIds: readonly string[]
): string[][] {
  if (serverIds.length <= 1) return []
  if (input.pinServerId) return []
  const document = input.document
  if (!document) return []
  const spanningSlots = slots.map((slot) => ({
    serviceId: slot.serviceId,
    serverId: slot.serverId,
  }))
  const serviceRows = input.services.map((row) => ({
    id: row.serviceId,
    composeServiceName: row.spec.composeServiceName,
  }))
  return collectSpanningComposeNetworkKeys(document, spanningSlots, serviceRows).map((key) =>
    participatingServerIdsForNetwork(document, spanningSlots, serviceRows, key)
  )
}

type SpanPairs = {
  /** Pairs that share a trusted LAN (no tunnel). */
  lan: Array<[string, string]>
  /** Pairs that need a TurboFabric tunnel. */
  remote: Array<[string, string]>
}

function splitSpanPairs(input: PlanEnvironmentInput, participants: readonly string[]): SpanPairs {
  const pairs: SpanPairs = { lan: [], remote: [] }
  const sorted = [...participants].sort((a, b) => a.localeCompare(b))
  for (const [index, a] of sorted.entries()) {
    for (const b of sorted.slice(index + 1)) {
      if (input.pairSharesTrustedLan?.(a, b) === true) pairs.lan.push([a, b])
      else pairs.remote.push([a, b])
    }
  }
  return pairs
}

function serverName(input: PlanEnvironmentInput, id: string): string {
  return input.servers.find((row) => row.id === id)?.name ?? id
}

function joinNames(names: readonly string[]): string {
  return names.join(', ')
}

/**
 * The servers outside the biggest shared-LAN group of a mixed network: the
 * ones "in a different datacenter" from the rest.
 */
function serversOutsideLanGroup(participants: readonly string[], pairs: SpanPairs): string[] {
  const partners = new Map<string, Set<string>>(participants.map((id) => [id, new Set([id])]))
  for (const [a, b] of pairs.lan) {
    partners.get(a)?.add(b)
    partners.get(b)?.add(a)
  }
  let anchor = new Set<string>()
  for (const group of partners.values()) if (group.size > anchor.size) anchor = group
  return participants.filter((id) => !anchor.has(id))
}

function fabricOffRefusal(
  input: PlanEnvironmentInput,
  participants: readonly string[],
  pairs: SpanPairs
): string {
  if (pairs.lan.length === 0) {
    return 'Enable TurboFabric to span a `driver: overlay` network across servers'
  }
  const outside = serversOutsideLanGroup(participants, pairs).map((id) => serverName(input, id))
  return `${joinNames(outside)} ${
    outside.length === 1 ? 'is' : 'are'
  } in a different datacenter from the other servers on this network, so it needs TurboFabric. Turn TurboFabric on, or keep the network on servers that share a trusted datacenter network.`
}

function switchedOffRefusal(input: PlanEnvironmentInput, pairs: SpanPairs): string | null {
  const inRemotePair = new Set(pairs.remote.flat())
  const optedOut = input.servers
    .filter((row) => inRemotePair.has(row.id) && row.fabricEnabled === false)
    .map((row) => row.name ?? row.id)
  if (optedOut.length === 0) return null
  return `TurboFabric is switched off for ${joinNames(optedOut)}. Switch it on for ${
    optedOut.length === 1 ? 'that server' : 'those servers'
  } to span a \`driver: overlay\` network across servers`
}

/**
 * Phase scope: a network that mixes LAN pairs with remote ones needs a direct
 * tunnel for every remote pair; traffic is not sent across datacenters
 * through a gateway for a server that is on the LAN.
 */
function noDirectTunnelRefusal(input: PlanEnvironmentInput, pairs: SpanPairs): string | null {
  if (pairs.lan.length === 0 || !input.pairHasDirectTunnel) return null
  const missing = pairs.remote.find(([a, b]) => input.pairHasDirectTunnel?.(a, b) === false)
  if (!missing) return null
  const [a, b] = missing.map((id) => serverName(input, id))
  return `${a} has no direct TurboFabric path to ${b}. A network that mixes servers on a shared LAN with servers elsewhere needs a direct tunnel between them: give ${a} or ${b} a public address, or keep the network on one side.`
}

function networkRefusal(
  input: PlanEnvironmentInput,
  participants: readonly string[]
): string | null {
  const pairs = splitSpanPairs(input, participants)
  if (pairs.remote.length === 0) return null
  if (!input.fabricEnabled) return fabricOffRefusal(input, participants, pairs)
  return switchedOffRefusal(input, pairs) ?? noDirectTunnelRefusal(input, pairs)
}

/**
 * Why a spanning plan cannot be carried, or null when it can (or needs
 * nothing). A network whose servers all share a trusted LAN needs no
 * TurboFabric. Otherwise the org must have TurboFabric on (a mixed network
 * names the servers in a different datacenter), every server in a pair that
 * needs a tunnel must be switched on, and a mixed network needs a direct
 * tunnel for each remote pair.
 */
function fabricRefusalForPlan(
  input: PlanEnvironmentInput,
  slots: readonly DesiredSlotInput[],
  serverIds: readonly string[]
): string | null {
  for (const participants of spanningNetworksForPlan(input, slots, serverIds)) {
    const refusal = networkRefusal(input, participants)
    if (refusal) return refusal
  }
  return null
}

/**
 * Name the reason a slot found no host, distinguishing the cap from the rest.
 *
 * "Which filter emptied the candidate list" is the operator's next question,
 * and the three answers send them to different places: labels/connectivity, a
 * published host port, or the density cap. Checked in that order because a host
 * still holding port room proves the pool itself was not the problem.
 */
function unplacedSlotError(params: {
  name: string
  slot: number
  eligible: readonly FleetServer[]
  occupied: ReadonlySet<string>
  requireEmptyHost: boolean
  cap: number | null
}): { error: ScheduleErrorCode; message: string } {
  const { name, slot, eligible, occupied, requireEmptyHost, cap } = params
  const withPortRoom = requireEmptyHost ? eligible.filter((row) => !occupied.has(row.id)) : eligible
  if (cap !== null && withPortRoom.length > 0) {
    return {
      error: 'max_replicas_per_node_exceeded',
      message:
        `${name} slot ${String(slot)} has no server left under ` +
        `max_replicas_per_node ${String(cap)}`,
    }
  }
  return {
    error: requireEmptyHost ? 'host_port_conflict' : 'no_eligible_server',
    message: `Could not place ${name} slot ${String(slot)}`,
  }
}

function placeService(params: {
  service: PlannedService
  eligible: FleetServer[]
  existing: Map<string, string>
  requireEmptyHost: boolean
  preferredId: string | null
}): { slots: DesiredSlotInput[] } | { error: ScheduleErrorCode; message: string } {
  const { service, eligible, existing, requireEmptyHost, preferredId } = params
  const name = service.spec.composeServiceName
  const cap = service.spec.maxReplicasPerNode
  const count = replicaCount(service.spec, eligible.length)
  if (count < 1) {
    return {
      error: 'no_eligible_server',
      message: `No eligible server for ${name}`,
    }
  }
  if (requireEmptyHost && count > eligible.length) {
    return {
      error: 'host_port_conflict',
      message:
        `${name} publishes a host port and cannot ` +
        `place ${String(count)} replicas on ${String(eligible.length)} server(s)`,
    }
  }
  // Answered before the loop so the operator gets the arithmetic rather than
  // "could not place slot 4": the cap and the replica count are simply
  // incompatible with the number of hosts the constraints leave.
  if (cap !== null && count > cap * eligible.length) {
    return {
      error: 'max_replicas_per_node_exceeded',
      message:
        `${name} requires more replicas than max_replicas_per_node allows ` +
        `across ${String(eligible.length)} eligible server(s) — ` +
        `${String(count)} requested, at most ${String(cap)} per server`,
    }
  }

  const usedLabelValues = new Map<string, number>()
  const occupied = new Set<string>()
  const perNodeCounts = new Map<string, number>()
  const slots: DesiredSlotInput[] = []

  for (let slot = 0; slot < count; slot += 1) {
    const stickyId = existing.get(`${service.serviceId}:${String(slot)}`)
    const sticky = stickyId ? eligible.find((row) => row.id === stickyId) : undefined
    // Stickiness yields to the cap. A cap lowered since the last deploy would
    // otherwise be honoured for new slots and quietly violated by the ones that
    // were already somewhere, which is not a cap at all.
    const stickyFits =
      sticky !== undefined && (cap === null || (perNodeCounts.get(sticky.id) ?? 0) < cap)
    const chosen =
      (stickyFits ? sticky : undefined) ??
      pickServer({
        eligible,
        spreadKeys: service.spec.spreadKeys,
        usedLabelValues,
        occupied,
        requireEmptyHost,
        preferredId,
        perNodeCounts,
        maxReplicasPerNode: cap,
      })
    if (!chosen) {
      return unplacedSlotError({
        name,
        slot,
        eligible,
        occupied,
        requireEmptyHost,
        cap,
      })
    }
    occupied.add(chosen.id)
    perNodeCounts.set(chosen.id, (perNodeCounts.get(chosen.id) ?? 0) + 1)
    recordSpread(chosen, service.spec.spreadKeys, usedLabelValues)
    slots.push({
      serviceId: service.serviceId,
      serverId: chosen.id,
      slot,
      desiredState: 'running',
    })
  }
  return { slots }
}

/**
 * Plan slots for an environment. Callers persist via `replaceEnvironmentSlots`
 * and `upsertDeploymentTargets`.
 */
export function planEnvironmentSchedule(input: PlanEnvironmentInput): SchedulePlan {
  if (input.services.length === 0) return planEmptyEnvironment(input)

  const pool = schedulingPool(input.servers, input.pinServerId, input.defaultServerId)
  if (pool.length === 0) {
    return fail('no_eligible_server', 'No connected servers are available')
  }

  const pinError = missingPinnedServer(input)
  if (pinError) return pinError

  const existing = existingByServiceSlot(input.existingTasks)
  const byId = new Map(input.services.map((row) => [row.serviceId, row]))
  const allTasks: DesiredSlotInput[] = []

  for (const group of colocationGroups(input.services)) {
    const placed = placeColocationGroup(group, byId, pool, existing, input)
    if (!placed.ok) return placed
    allTasks.push(...placed.slots)
  }

  const serverIds = [...new Set(allTasks.map((task) => task.serverId))].sort((a, b) =>
    a.localeCompare(b)
  )
  const fabricRefusal = fabricRefusalForPlan(input, allTasks, serverIds)
  if (fabricRefusal) return fail('turbofabric_required', fabricRefusal)

  allTasks.sort((a, b) => {
    const byService = a.serviceId.localeCompare(b.serviceId)
    if (byService !== 0) return byService
    return a.slot - b.slot
  })
  return { ok: true, slots: allTasks, serverIds }
}

export function localReplicaCounts(
  slots: readonly DesiredSlotInput[],
  serviceIdToName: ReadonlyMap<string, string>,
  serverId: string
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of slots) {
    if (task.serverId !== serverId) continue
    const name = serviceIdToName.get(task.serviceId)
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

export function localServiceNames(
  slots: readonly DesiredSlotInput[],
  serviceIdToName: ReadonlyMap<string, string>,
  serverId: string
): Set<string> {
  const names = new Set<string>()
  for (const task of slots) {
    if (task.serverId !== serverId) continue
    const name = serviceIdToName.get(task.serviceId)
    if (name) names.add(name)
  }
  return names
}
