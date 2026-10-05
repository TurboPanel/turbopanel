/**
 * Data behind the server-to-server traffic map of one server.
 *
 * For every other server this one can reach privately it answers, in plain
 * data: which shared networks exist, which one the routing rule picks (the
 * trusted network with the lowest priority number whose link is up on both
 * servers), which address each kind of traffic is planned onto, and, for the
 * TurboFabric tunnel only, which local NIC the kernel is really using.
 *
 * Planned and observed are kept apart on purpose. Database replication and
 * client connections are *planned*: the control plane chooses the address and
 * the operating system chooses the NIC for it. Only the tunnel has an
 * observed NIC (reported by the daemon), so only the tunnel row carries one.
 *
 * Pure: it reads the caches the endpoint resolver already loads plus the
 * daemon-reported addresses and tunnel observations. No process, no probe.
 */

import type { ServerReportedIp } from '../../contracts/server-addresses.ts'
import {
  type PrivateEndpointCaches,
  type PrivateEndpointError,
  type PrivateEndpointPurpose,
  partitionSharedDatacenters,
  pinAddressForDatacenter,
  resolveOneFromCaches,
  splitTrustedByLink,
} from './private-endpoint.ts'
import { defaultDatacenterPolicyRow } from './datacenter-networks.ts'
import { addressMatchKey } from './pin-link-state.ts'
import type { DatacenterMembershipRow } from './datacenter-membership.ts'

export type TrafficMapLink = 'up' | 'down' | 'unknown'

export const TRAFFIC_MAP_PURPOSES: readonly PrivateEndpointPurpose[] = [
  'failover-replication',
  'read-replication',
  'client-backend',
]

/**
 * - `chosen`: carries server-to-server traffic for this pair (best priority among networks that are up and usable by both servers).
 * - `standby`: trusted and up with an address both servers can use, but a better-priority network is chosen; takes over if that one goes down.
 * - `no_common_address`: trusted and up, but the two servers share no address family on it, so it cannot carry traffic.
 * - `link_down`: trusted, but the NIC reports no link on one of the two servers; used only as a last resort.
 * - `untrusted`: never used for server-to-server traffic.
 */
export type TrafficMapNetworkState =
  'chosen' | 'standby' | 'no_common_address' | 'link_down' | 'untrusted'

export type TrafficMapPeerNetwork = {
  datacenterId: string
  name: string | null
  priority: number
  trusted: boolean
  state: TrafficMapNetworkState
  localAddress: string | null
  peerAddress: string | null
  localInterface: string | null
  peerInterface: string | null
  localLink: TrafficMapLink
  peerLink: TrafficMapLink
}

export type TrafficMapPlanned = {
  transport: 'local' | 'datacenter' | 'fabric' | 'public'
  address: string
  datacenterId: string | null
  /** Local NIC the address leaves by, from the daemon-reported subnets; null when unknown. */
  localInterface: string | null
  /** True when this network was used only because nothing that is up could carry the traffic. */
  linkDown: boolean
}

export type TrafficMapTrafficRow = {
  purpose: PrivateEndpointPurpose
  planned: TrafficMapPlanned | null
  /** Set when no path exists (`private_path_unavailable`, `private_family_mismatch`, ...). */
  error: PrivateEndpointError['kind'] | null
  /**
   * Planned on the chosen network of this pair. False when it rides fabric or
   * public, a network that is down, or when there is no chosen network.
   */
  onChosenNetwork: boolean
}

export type TrafficMapFabricRow = {
  /** Path the control plane planned for the tunnel (`direct_lan`, `direct_public`, ...). */
  plannedPath: string | null
  plannedEndpoint: string | null
  degraded: boolean
  /** What the daemon last saw on the tunnel. Absent until the first report. */
  observed: {
    at: string
    /** Local NIC the tunnel to this peer uses; absent when it follows the default route. */
    interface: string | null
    endpoint: string | null
    lastHandshakeAt: string | null
    transferRx: number | null
    transferTx: number | null
  } | null
  /** True/false when it can be told whether the tunnel rides the chosen network; null when unknown. */
  onChosenNetwork: boolean | null
}

export type TrafficMapPeer = {
  serverId: string
  name: string | null
  /** Datacenter the pair's traffic rides, or null when no shared trusted network is up. */
  chosenDatacenterId: string | null
  sharedNetworks: TrafficMapPeerNetwork[]
  traffic: TrafficMapTrafficRow[]
  fabric: TrafficMapFabricRow | null
}

/**
 * Where to read this NIC's byte counters. Counters are not repeated here: the
 * existing metrics series route (`family: network`, `deviceId`) serves them,
 * and only for NICs in the monitored set (`monitored: true`).
 */
export type TrafficMapNicMetrics = {
  deviceId: string
  monitored: boolean
  speedMbps: number | null
}

export type TrafficMapNic = {
  name: string
  link: TrafficMapLink
  /** This NIC carries the host's default route. */
  defaultRoute: boolean
  addresses: Array<{ address: string; datacenterId: string | null }>
  /** Null when the server has no recorded topology entry for this NIC. */
  metrics: TrafficMapNicMetrics | null
}

export type ServerTrafficMap = {
  serverId: string
  nics: TrafficMapNic[]
  peers: TrafficMapPeer[]
}

export type TrafficMapRelayObservedPeer = {
  publicKey?: string
  endpoint?: string
  interface?: string
  lastHandshakeAt?: string
  transferRx?: number
  transferTx?: number
}

/** The slice of a relay record the map reads. */
export type TrafficMapRelay = {
  serverId: string
  publicKey: string | null
  metadata: {
    observed?: { at: string; peers: readonly TrafficMapRelayObservedPeer[] }
    paths?: {
      entries: ReadonlyArray<{
        peerServerId: string
        selected: string
        endpoint?: string
        degraded: boolean
      }>
    }
  }
}

export type BuildServerTrafficMapInput = {
  serverId: string
  peers: ReadonlyArray<{ serverId: string; name: string | null }>
  caches: PrivateEndpointCaches
  datacenterNames: ReadonlyMap<string, string>
  reportedIpsByServer: ReadonlyMap<string, readonly ServerReportedIp[]>
  /** Relay records of the organization fabric (empty when it is off). */
  fabricRelays: readonly TrafficMapRelay[]
  /** This server's NIC metrics pointers by interface name (empty when unknown). */
  nicMetrics?: ReadonlyMap<string, TrafficMapNicMetrics>
}

function ipKey(address: string): string {
  return addressMatchKey(address)
}

function reportedFor(
  reported: readonly ServerReportedIp[] | undefined,
  address: string | null
): ServerReportedIp | undefined {
  if (!address || !reported) return undefined
  const key = ipKey(address)
  return reported.find((row) => ipKey(row.address) === key)
}

function linkOf(row: ServerReportedIp | undefined): TrafficMapLink {
  if (!row?.link) return 'unknown'
  return row.link
}

function pinsIn(
  pins: readonly DatacenterMembershipRow[],
  datacenterId: string
): DatacenterMembershipRow | undefined {
  return pins.find((pin) => pin.datacenterId === datacenterId)
}

type NetworkOrder = {
  chosen: string | null
  ordered: Array<{ datacenterId: string; state: TrafficMapNetworkState }>
}

function orderNetworks(
  fromPins: readonly DatacenterMembershipRow[],
  toPins: readonly DatacenterMembershipRow[],
  caches: PrivateEndpointCaches
): NetworkOrder {
  const partition = partitionSharedDatacenters(fromPins, toPins, caches.policiesByDatacenter)
  const byLink = splitTrustedByLink(partition.trusted, fromPins, toPins)
  // Chosen = the best network that is up *and* has an address both servers
  // can use (same family), i.e. the one the resolver really picks.
  const usable = (datacenterId: string): boolean =>
    pinAddressForDatacenter(
      fromPins,
      toPins,
      datacenterId,
      (caches.policiesByDatacenter.get(datacenterId) ?? defaultDatacenterPolicyRow())
        .addressPreference
    ) !== null
  const chosen = byLink.available.find(usable) ?? null
  const availableState = (datacenterId: string): TrafficMapNetworkState => {
    if (datacenterId === chosen) return 'chosen'
    return usable(datacenterId) ? 'standby' : 'no_common_address'
  }
  const ordered: NetworkOrder['ordered'] = [
    ...byLink.available.map((datacenterId) => ({
      datacenterId,
      state: availableState(datacenterId),
    })),
    ...byLink.down.map((datacenterId) => ({ datacenterId, state: 'link_down' as const })),
    ...partition.untrusted.map((datacenterId) => ({ datacenterId, state: 'untrusted' as const })),
  ]
  return { chosen, ordered }
}

function peerNetworks(
  order: NetworkOrder,
  fromPins: readonly DatacenterMembershipRow[],
  toPins: readonly DatacenterMembershipRow[],
  input: BuildServerTrafficMapInput,
  peerServerId: string
): TrafficMapPeerNetwork[] {
  const selfIps = input.reportedIpsByServer.get(input.serverId)
  const peerIps = input.reportedIpsByServer.get(peerServerId)
  const localSide = fromPins
  const peerSide = toPins
  return order.ordered.map(({ datacenterId, state }) => {
    const policy =
      input.caches.policiesByDatacenter.get(datacenterId) ?? defaultDatacenterPolicyRow()
    // `pinAddressForDatacenter(a, b, ...)` returns b's address in the family
    // both share, so the local address is asked for with the sides swapped.
    const localAddress =
      pinAddressForDatacenter(peerSide, localSide, datacenterId, policy.addressPreference) ??
      pinsIn(fromPins, datacenterId)?.address ??
      null
    const peerAddress =
      pinAddressForDatacenter(fromPins, toPins, datacenterId, policy.addressPreference) ??
      pinsIn(toPins, datacenterId)?.address ??
      null
    const localReported = reportedFor(selfIps, localAddress)
    const peerReported = reportedFor(peerIps, peerAddress)
    return {
      datacenterId,
      name: input.datacenterNames.get(datacenterId) ?? null,
      priority: policy.priority,
      trusted: policy.trusted,
      state,
      localAddress,
      peerAddress,
      localInterface: localReported?.interface ?? null,
      peerInterface: peerReported?.interface ?? null,
      localLink: linkOf(localReported),
      peerLink: linkOf(peerReported),
    }
  })
}

function trafficRow(
  purpose: PrivateEndpointPurpose,
  peerServerId: string,
  order: NetworkOrder,
  input: BuildServerTrafficMapInput
): TrafficMapTrafficRow {
  const resolved = resolveOneFromCaches({
    fromServerId: input.serverId,
    toServerId: peerServerId,
    purpose,
    ...input.caches,
  })
  if ('kind' in resolved) {
    return {
      purpose,
      planned: null,
      error: resolved.kind,
      onChosenNetwork: false,
    }
  }
  const datacenterId = resolved.datacenterId ?? null
  const onChosenNetwork =
    resolved.transport === 'datacenter' && datacenterId !== null && datacenterId === order.chosen
  return {
    purpose,
    planned: {
      transport: resolved.transport,
      address: resolved.address,
      datacenterId,
      localInterface:
        resolved.transport === 'datacenter' ? localInterfaceOfPin(input, datacenterId) : null,
      linkDown: resolved.linkDown === true,
    },
    error: null,
    onChosenNetwork,
  }
}

function localInterfaceOfPin(
  input: BuildServerTrafficMapInput,
  datacenterId: string | null
): string | null {
  if (datacenterId === null) return null
  const pins = input.caches.membershipsByServer.get(input.serverId) ?? []
  const pin = pinsIn(pins, datacenterId)
  if (!pin) return null
  return reportedFor(input.reportedIpsByServer.get(input.serverId), pin.address)?.interface ?? null
}

function fabricRow(
  peerServerId: string,
  order: NetworkOrder,
  networks: readonly TrafficMapPeerNetwork[],
  input: BuildServerTrafficMapInput
): TrafficMapFabricRow | null {
  const selfRelay = input.fabricRelays.find((row) => row.serverId === input.serverId)
  const peerRelay = input.fabricRelays.find((row) => row.serverId === peerServerId)
  if (!selfRelay || !peerRelay) return null

  const path = selfRelay.metadata.paths?.entries.find(
    (entry) => entry.peerServerId === peerServerId
  )
  const observedPeer = peerRelay.publicKey
    ? selfRelay.metadata.observed?.peers.find((entry) => entry.publicKey === peerRelay.publicKey)
    : undefined
  const observedAt = selfRelay.metadata.observed?.at
  const observed =
    observedPeer && observedAt
      ? {
          at: observedAt,
          interface: observedPeer.interface ?? null,
          endpoint: observedPeer.endpoint ?? null,
          lastHandshakeAt: observedPeer.lastHandshakeAt ?? null,
          transferRx: observedPeer.transferRx ?? null,
          transferTx: observedPeer.transferTx ?? null,
        }
      : null

  return {
    plannedPath: path?.selected ?? null,
    plannedEndpoint: path?.endpoint ?? null,
    degraded: path?.degraded ?? false,
    observed,
    onChosenNetwork: fabricOnChosenNetwork(order, networks, observed, path?.endpoint),
  }
}

/**
 * Whether the tunnel rides the chosen network. The observed NIC settles it
 * when both it and the chosen network's NIC are known; otherwise the endpoint
 * (observed, else planned) is compared with the peer's address on the chosen
 * network. `null` when there is nothing to compare (no chosen network, or a
 * tunnel the daemon has not reported).
 */
function fabricOnChosenNetwork(
  order: NetworkOrder,
  networks: readonly TrafficMapPeerNetwork[],
  observed: TrafficMapFabricRow['observed'],
  plannedEndpoint: string | undefined
): boolean | null {
  if (order.chosen === null) return null
  const chosen = networks.find((row) => row.datacenterId === order.chosen)
  if (!chosen) return null
  if (observed?.interface && chosen.localInterface) {
    return observed.interface === chosen.localInterface
  }
  const endpoint = observed?.endpoint ?? plannedEndpoint
  if (endpoint && chosen.peerAddress) {
    return endpointHost(endpoint) === ipKey(chosen.peerAddress)
  }
  return null
}

function endpointHost(endpoint: string): string {
  if (endpoint.startsWith('[')) {
    const close = endpoint.indexOf(']')
    return ipKey(close > 1 ? endpoint.slice(1, close) : endpoint)
  }
  const colon = endpoint.lastIndexOf(':')
  const host = colon > 0 && endpoint.indexOf(':') === colon ? endpoint.slice(0, colon) : endpoint
  return ipKey(host)
}

function nicList(input: BuildServerTrafficMapInput): TrafficMapNic[] {
  const reported = input.reportedIpsByServer.get(input.serverId) ?? []
  const pins = input.caches.membershipsByServer.get(input.serverId) ?? []
  const datacenterByAddress = new Map(pins.map((pin) => [ipKey(pin.address), pin.datacenterId]))
  const byName = new Map<string, TrafficMapNic>()
  for (const row of reported) {
    if (!row.interface) continue
    const nic = byName.get(row.interface) ?? {
      name: row.interface,
      link: 'unknown' as TrafficMapLink,
      defaultRoute: false,
      addresses: [],
      metrics: input.nicMetrics?.get(row.interface) ?? null,
    }
    if (row.link) nic.link = row.link
    if (row.preferred) nic.defaultRoute = true
    nic.addresses.push({
      address: row.address,
      datacenterId: datacenterByAddress.get(ipKey(row.address)) ?? null,
    })
    byName.set(row.interface, nic)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function buildServerTrafficMap(input: BuildServerTrafficMapInput): ServerTrafficMap {
  const fromPins = input.caches.membershipsByServer.get(input.serverId) ?? []
  const peers = input.peers
    .filter((peer) => peer.serverId !== input.serverId)
    .map((peer): TrafficMapPeer => {
      const toPins = input.caches.membershipsByServer.get(peer.serverId) ?? []
      const order = orderNetworks(fromPins, toPins, input.caches)
      const sharedNetworks = peerNetworks(order, fromPins, toPins, input, peer.serverId)
      return {
        serverId: peer.serverId,
        name: peer.name,
        chosenDatacenterId: order.chosen,
        sharedNetworks,
        traffic: TRAFFIC_MAP_PURPOSES.map((purpose) =>
          trafficRow(purpose, peer.serverId, order, input)
        ),
        fabric: fabricRow(peer.serverId, order, sharedNetworks, input),
      }
    })
    .sort((a, b) => (a.name ?? a.serverId).localeCompare(b.name ?? b.serverId))
  return { serverId: input.serverId, nics: nicList(input), peers }
}
