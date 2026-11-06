/**
 * Keep running cross-server container networks working when the pair rule
 * changes under them.
 *
 * A container network whose servers are all trusted LAN pairs rides the LAN
 * with no tunnel, whether TurboFabric is on, paused or off. When a pair stops
 * being a LAN pair (its datacenter is marked untrusted, one server leaves the
 * datacenter, a daemon stops routing over the LAN) the network needs a
 * tunnel. With TurboFabric running for both servers the mesh is re-planned
 * and carries it; otherwise the network would silently break, so the change
 * is refused with a plain sentence naming the networks and servers.
 *
 * Also used by "Remove TurboFabric completely" (networks that ride the LAN
 * are kept) and by the deploy's last check before delivering.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, network, server, subnet } from '../../db/schema.ts'
import { defaultDatacenterPolicyRow } from '../net/datacenter-networks.ts'
import { type LanPairInputs, serversShareTrustedLan } from '../net/private-endpoint.ts'
import { getOrganizationFabric, isFabricPaused } from './fabric-records.ts'
import { loadLanPairInputs } from './lan-pairs.ts'

/** A cross-server container network and the servers holding a piece of it. */
export type ContainerNetworkPieces = {
  id: string
  label: string
  serverIds: string[]
}

/** The operator's words for a container network. */
export function containerNetworkLabel(name: string, environmentName: string | null): string {
  return environmentName
    ? `container network "${name}" in environment "${environmentName}"`
    : `container network "${name}"`
}

/** Every cross-server container network of the organization with its pieces. */
export async function loadContainerNetworkPieces(
  db: Db,
  organizationId: string
): Promise<ContainerNetworkPieces[]> {
  const rows = await db
    .select({
      id: network.id,
      name: network.name,
      composeKey: network.composeKey,
      environmentName: environment.name,
      serverId: subnet.serverId,
    })
    .from(subnet)
    .innerJoin(network, eq(network.id, subnet.networkId))
    .leftJoin(environment, eq(environment.id, network.environmentId))
    .where(and(eq(network.organizationId, organizationId), eq(network.kind, 'compose')))
  const byId = new Map<string, ContainerNetworkPieces>()
  for (const row of rows) {
    const entry = byId.get(row.id) ?? {
      id: row.id,
      label: containerNetworkLabel(row.composeKey ?? row.name ?? row.id, row.environmentName),
      serverIds: [],
    }
    if (!entry.serverIds.includes(row.serverId)) entry.serverIds.push(row.serverId)
    byId.set(row.id, entry)
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

type Pair = [string, string]

/** Every pair of the servers once, each pair sorted by id. */
export function pairsOf(serverIds: readonly string[]): Pair[] {
  const sorted = [...serverIds].sort((a, b) => a.localeCompare(b))
  const out: Pair[] = []
  for (const [index, a] of sorted.entries()) {
    for (const b of sorted.slice(index + 1)) out.push([a, b])
  }
  return out
}

/** True when every pair of the network's servers is a trusted LAN pair (no tunnel needed). */
export function networkRidesLan(pieces: ContainerNetworkPieces, inputs: LanPairInputs): boolean {
  return pairsOf(pieces.serverIds).every(([a, b]) => serversShareTrustedLan(a, b, inputs))
}

/** A network and the pairs of its servers no tunnel would carry. */
export type UncarriedNetwork = {
  network: ContainerNetworkPieces
  pairs: Pair[]
}

/**
 * Whether a running TurboFabric would carry a tunnel between two servers:
 * the org fabric exists, is not paused, and neither server is switched off.
 */
export type TunnelCarriage = (a: string, b: string) => boolean

export async function loadTunnelCarriage(
  db: Db,
  organizationId: string,
  serverIds: readonly string[]
): Promise<TunnelCarriage> {
  const fabricRow = await getOrganizationFabric(db, organizationId)
  if (!fabricRow || isFabricPaused(fabricRow) || serverIds.length === 0) return () => false
  const rows = await db
    .select({ id: server.id, isFabricEnabled: server.isFabricEnabled })
    .from(server)
    .where(inArray(server.id, [...new Set(serverIds)]))
  const off = new Set(rows.filter((row) => row.isFabricEnabled === false).map((row) => row.id))
  return (a, b) => !off.has(a) && !off.has(b)
}

/**
 * Networks with a pair that is not a LAN pair under `inputs` and that no
 * tunnel carries. With `before`, only pairs that were LAN pairs there count
 * (a pair that already needed a tunnel is not this change's doing).
 */
export function uncarriedNetworks(
  networks: readonly ContainerNetworkPieces[],
  inputs: LanPairInputs,
  carried: TunnelCarriage,
  before?: LanPairInputs
): UncarriedNetwork[] {
  const out: UncarriedNetwork[] = []
  for (const entry of networks) {
    const pairs = pairsOf(entry.serverIds).filter(
      ([a, b]) =>
        (before === undefined || serversShareTrustedLan(a, b, before)) &&
        !serversShareTrustedLan(a, b, inputs) &&
        !carried(a, b)
    )
    if (pairs.length > 0) out.push({ network: entry, pairs })
  }
  return out
}

/** A change to the pair-rule inputs a route is about to write. */
export type LanPairChange =
  | { kind: 'untrust_datacenter'; datacenterId: string }
  | { kind: 'leave_datacenter'; datacenterId: string; serverId: string }

/** The pair-rule inputs as they will be once `change` is written. */
export function applyLanPairChange(inputs: LanPairInputs, change: LanPairChange): LanPairInputs {
  if (change.kind === 'untrust_datacenter') {
    const policies = new Map(inputs.policiesByDatacenter)
    const current = policies.get(change.datacenterId) ?? defaultDatacenterPolicyRow()
    policies.set(change.datacenterId, { ...current, trusted: false })
    return { ...inputs, policiesByDatacenter: policies }
  }
  const memberships = new Map(inputs.membershipsByServer)
  memberships.set(
    change.serverId,
    (memberships.get(change.serverId) ?? []).filter(
      (pin) => pin.datacenterId !== change.datacenterId
    )
  )
  return { ...inputs, membershipsByServer: memberships }
}

async function serverNamesById(db: Db, serverIds: readonly string[]): Promise<Map<string, string>> {
  if (serverIds.length === 0) return new Map()
  const rows = await db
    .select({ id: server.id, name: server.name, hostname: server.hostname })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  return new Map(rows.map((row) => [row.id, row.name ?? row.hostname ?? row.id]))
}

/** The networks and server names a refusal names. */
export type LanPairRefusal = {
  networks: Array<{ id: string; label: string }>
  servers: Array<{ id: string; name: string }>
  message: string
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/** Name the networks and servers; `lead` says what would happen. */
export async function describeUncarried(
  db: Db,
  uncarried: readonly UncarriedNetwork[],
  lead: (parts: { networks: string; servers: string }) => string
): Promise<LanPairRefusal> {
  const serverIds = [...new Set(uncarried.flatMap((row) => row.pairs.flat()))].sort((a, b) =>
    a.localeCompare(b)
  )
  const names = await serverNamesById(db, serverIds)
  const servers = serverIds.map((id) => ({ id, name: names.get(id) ?? id }))
  const networks = uncarried.map((row) => ({ id: row.network.id, label: row.network.label }))
  return {
    networks,
    servers,
    message: lead({
      networks: joinWords(networks.map((row) => row.label)),
      servers: joinWords(servers.map((row) => row.name)),
    }),
  }
}

/**
 * Refuse a change that would turn a LAN pair holding a cross-server container
 * network into a pair that needs a tunnel while TurboFabric is not running for
 * it. Null when the change is fine (no such network, or TurboFabric carries
 * the new tunnel: the caller's fan-out re-plans the mesh).
 */
export async function findLanPairChangeRefusal(
  db: Db,
  params: { organizationId: string; change: LanPairChange }
): Promise<LanPairRefusal | null> {
  const networks = (await loadContainerNetworkPieces(db, params.organizationId)).filter(
    (row) => row.serverIds.length > 1
  )
  if (networks.length === 0) return null
  const serverIds = [...new Set(networks.flatMap((row) => row.serverIds))]
  const [before, carried] = await Promise.all([
    loadLanPairInputs(db, serverIds),
    loadTunnelCarriage(db, params.organizationId, serverIds),
  ])
  const after = applyLanPairChange(before, params.change)
  const uncarried = uncarriedNetworks(networks, after, carried, before)
  if (uncarried.length === 0) return null
  return await describeUncarried(
    db,
    uncarried,
    ({ networks: labels, servers }) =>
      `This change would stop ${servers} sharing a trusted LAN, and ${labels} ${
        uncarried.length === 1 ? 'runs' : 'run'
      } over it with no tunnel while TurboFabric is not running for them. Turn TurboFabric on first, or move or remove ${
        uncarried.length === 1 ? 'that network' : 'those networks'
      }.`
  )
}

/**
 * The deploy's last check, right before it delivers anything: every pair of
 * servers on each spanning network must still be a trusted LAN pair or be
 * carried by a running TurboFabric. The planner checked the same rule, but
 * a datacenter or daemon change can land in between. Null when fine.
 */
export async function findDeployLanPairRefusal(
  db: Db,
  params: {
    organizationId: string
    networks: ReadonlyArray<{ key: string; serverIds: readonly string[] }>
  }
): Promise<LanPairRefusal | null> {
  const networks = params.networks
    .filter((row) => row.serverIds.length > 1)
    .map((row) => ({
      id: row.key,
      label: containerNetworkLabel(row.key, null),
      serverIds: [...row.serverIds],
    }))
  if (networks.length === 0) return null
  const serverIds = [...new Set(networks.flatMap((row) => row.serverIds))]
  const [inputs, carried] = await Promise.all([
    loadLanPairInputs(db, serverIds),
    loadTunnelCarriage(db, params.organizationId, serverIds),
  ])
  const uncarried = uncarriedNetworks(networks, inputs, carried)
  if (uncarried.length === 0) return null
  return await describeUncarried(
    db,
    uncarried,
    ({ networks: labels, servers }) =>
      `${servers} no longer share a trusted LAN, and ${labels} needs one while TurboFabric is not running for them. Turn TurboFabric on, or deploy again to keep the network on servers that share a trusted datacenter network.`
  )
}
