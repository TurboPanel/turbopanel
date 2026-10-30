import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { fabric, ip, relay, server } from '../../db/schema.ts'
import { inetAddressToString } from '../../lib/ip-address.ts'
import { relayCarriesTraffic, relayServerSwitchedOn } from '../fabric/relay-filters.ts'
import { loadLanRouteServerIds } from '../fabric/lan-pairs.ts'
import { pairTunnelHealth } from '../fabric/peer-health.ts'
import type { RelayMetadata } from '../fabric/fabric-records.ts'
import {
  defaultDatacenterPolicyRow,
  loadDatacenterPolicies,
  type DatacenterAddressPreference,
  type DatacenterPolicyRow,
} from './datacenter-networks.ts'
import {
  loadDatacenterMembershipsForServers,
  sharedDatacenterIds,
  type DatacenterMembershipRow,
} from './datacenter-membership.ts'

export type PrivateEndpointPurpose = 'failover-replication' | 'read-replication' | 'client-backend'

export type PrivateEndpointTransport = 'local' | 'datacenter' | 'fabric' | 'public'

export type ResolvedPrivateEndpoint = {
  address: string
  transport: PrivateEndpointTransport
  /** Present when transport is `datacenter`. */
  datacenterId?: string
  /**
   * Present (`true`) when transport is `datacenter` and that network's link is
   * reported down on one of the two servers: it was chosen only because no
   * network that is up could carry the traffic.
   */
  linkDown?: true
  /** Present when transport is `fabric`. */
  fabricId?: string
  /**
   * Present (`true`) when transport is `public` although the two servers share
   * a datacenter network marked untrusted: TurboFabric could not carry the
   * traffic (off, paused, switched out or not healthy), so it falls to the
   * public address with engine TLS only. New placements refuse this; running
   * traffic keeps it and the server traffic map reports it.
   */
  untrustedPublic?: true
  /**
   * Present (`true`) when transport is `fabric` but the tunnel has no recent
   * handshake or the other daemon is offline. The tunnel address is still
   * returned so a replication path never turns into an error just because of
   * a short gap (or a lost host during a failover); new placements refuse it.
   */
  tunnelDown?: true
}

export type PrivateEndpointError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | {
      kind: 'private_path_unavailable'
      fromServerId: string
      toServerId: string
    }
  | {
      kind: 'private_family_mismatch'
      fromServerId: string
      toServerId: string
      datacenterId: string
    }
  | {
      /**
       * The only datacenters the pair shares are `trusted: false`, and
       * TurboFabric cannot carry the traffic right now (off, paused, switched
       * out or not healthy). Failover replication never rides an untrusted
       * network in plain and never falls to the public address. `datacenterId`
       * is the first untrusted shared datacenter (priority order) for
       * operator messaging.
       */
      kind: 'untrusted_network_needs_fabric'
      fromServerId: string
      toServerId: string
      datacenterId: string
    }

export function isPrivateEndpointError(value: unknown): value is PrivateEndpointError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/**
 * Map a prepare error to a 422 JSON body with `{ error: kind }` only — never
 * leak id fields on the wire (mirrors managed `prepareErrorResponse`).
 */
export function privateEndpointErrorResponse(c: Context, error: PrivateEndpointError): Response {
  return c.json({ error: error.kind }, 422)
}

/** One membership pin address for a server (oldest first) — any datacenter. */
export async function loadServerDatacenterAddress(
  db: Db,
  serverId: string
): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'datacenter'), isNotNull(ip.datacenterId)))
    .orderBy(asc(ip.createdAt))
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

/**
 * This server's own TurboFabric (`tp0`) address, from its relay row.
 *
 * A server may be enrolled in more than one fabric; the oldest fabric wins,
 * matching how {@link resolvePrivateEndpoints} orders relay candidates. Returns
 * `null` when the server is not enrolled, which callers must treat as "the
 * fabric path is unavailable" rather than falling back to a wider address.
 */
export async function loadServerFabricAddress(db: Db, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ address: relay.address })
    .from(relay)
    .innerJoin(fabric, eq(relay.fabricId, fabric.id))
    .where(and(eq(relay.serverId, serverId), relayCarriesTraffic()))
    .orderBy(asc(fabric.createdAt))
    .limit(1)
  if (row === undefined) return null
  return inetAddressToString(row.address) ?? (typeof row.address === 'string' ? row.address : null)
}

/**
 * Newest/oldest `ip.scope='public'` address for a server (oldest first).
 *
 * Future: when no public `ip` row exists, a later phase may fall back to
 * daemon-reported public addresses from hello/heartbeat.
 */
export async function loadServerPublicAddress(db: Db, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'public')))
    .orderBy(asc(ip.createdAt))
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

/**
 * Oldest `ip.scope='public'` address per server (one `inArray` select).
 *
 * Future: when no public `ip` row exists, a later phase may fall back to
 * daemon-reported public addresses from hello/heartbeat.
 */
export async function loadPublicAddressesForServers(
  db: Db,
  serverIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (serverIds.length === 0) return out

  const rows = await db
    .select({
      serverId: ip.serverId,
      address: ip.address,
    })
    .from(ip)
    .where(and(eq(ip.scope, 'public'), isNotNull(ip.serverId), inArray(ip.serverId, serverIds)))
    .orderBy(asc(ip.createdAt))

  for (const row of rows) {
    if (!row.serverId || out.has(row.serverId)) continue
    const address = inetAddressToString(row.address)
    if (address) out.set(row.serverId, address)
  }
  return out
}

export type RelayJoinRow = {
  relayId: string
  serverId: string
  fabricId: string
  fabricCreatedAt: string
  address: string
  /** WireGuard public key once the daemon reported one; a keyless relay has no tunnel yet. */
  publicKey: string | null
  /** This relay's last reading of its peers (`relay.metadata.observed`). */
  observed?: NonNullable<RelayMetadata['observed']>
}

/**
 * Relays on fabrics that include at least one of the listed servers.
 * The peer address is `relay.address` (no `ip` join).
 */
async function loadFabricRelayRows(db: Db, serverIds: string[]): Promise<RelayJoinRow[]> {
  if (serverIds.length === 0) return []

  const membership = await db
    .select({ fabricId: relay.fabricId })
    .from(relay)
    .where(and(inArray(relay.serverId, serverIds), relayServerSwitchedOn()))

  const fabricIds = [...new Set(membership.map((row) => row.fabricId))]
  if (fabricIds.length === 0) return []

  const rows = await db
    .select({
      relayId: relay.id,
      serverId: relay.serverId,
      fabricId: relay.fabricId,
      fabricCreatedAt: fabric.createdAt,
      address: relay.address,
      publicKey: relay.publicKey,
      metadata: relay.metadata,
    })
    .from(relay)
    .innerJoin(fabric, eq(relay.fabricId, fabric.id))
    .where(and(inArray(relay.fabricId, fabricIds), relayCarriesTraffic()))
    .orderBy(asc(fabric.createdAt))

  const out: RelayJoinRow[] = []
  for (const row of rows) {
    const address =
      inetAddressToString(row.address) ??
      (typeof row.address === 'string' ? row.address : String(row.address))
    if (!address) continue
    out.push({
      relayId: row.relayId,
      serverId: row.serverId,
      fabricId: row.fabricId,
      fabricCreatedAt: row.fabricCreatedAt,
      address,
      publicKey: row.publicKey,
      observed: (row.metadata as RelayMetadata | null)?.observed,
    })
  }
  return out
}

/**
 * Address families present for a server in one datacenter.
 * Shared with TurboFabric path planning (`planRelayPath`).
 */
export function familiesInDatacenter(
  pins: readonly DatacenterMembershipRow[],
  datacenterId: string
): Set<4 | 6> {
  const families = new Set<4 | 6>()
  for (const pin of pins) {
    if (pin.datacenterId === datacenterId) families.add(pin.family)
  }
  return families
}

/**
 * Datacenter address-family preference order (RFC 6724 default IPv6-first).
 * Shared with TurboFabric path planning (`planRelayPath`).
 */
export function preferredFamilyOrder(preference: DatacenterAddressPreference): Array<4 | 6> {
  if (preference === 'ipv4') return [4, 6]
  return [6, 4]
}

/**
 * Family-intersected pin address for `toPins` in a shared datacenter.
 * Shared with TurboFabric path planning (`planRelayPath`).
 */
export function pinAddressForDatacenter(
  fromPins: readonly DatacenterMembershipRow[],
  toPins: readonly DatacenterMembershipRow[],
  datacenterId: string,
  preference: DatacenterAddressPreference
): string | null {
  const fromFamilies = familiesInDatacenter(fromPins, datacenterId)
  const toFamilies = familiesInDatacenter(toPins, datacenterId)
  const intersection = new Set<4 | 6>()
  for (const family of fromFamilies) {
    if (toFamilies.has(family)) intersection.add(family)
  }
  for (const family of preferredFamilyOrder(preference)) {
    if (!intersection.has(family)) continue
    const address = toPins.find(
      (row) => row.datacenterId === datacenterId && row.family === family
    )?.address
    if (address) return address
  }
  return null
}

export type SharedDatacenterPartition = {
  /** `trusted: true` shared datacenters, sorted `(priority asc, id asc)`. */
  trusted: string[]
  /** `trusted: false` shared datacenters, sorted `(priority asc, id asc)`. */
  untrusted: string[]
}

function policyFor(
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>,
  datacenterId: string
): DatacenterPolicyRow {
  return policiesByDatacenter.get(datacenterId) ?? defaultDatacenterPolicyRow()
}

/**
 * Split the datacenters two servers share into trusted / untrusted lists,
 * each ordered by `(priority asc, datacenterId asc)`. The id tiebreak keeps
 * the order deterministic when two datacenters carry the same priority.
 * Absent policy entries fall back to the documented defaults
 * (`priority` 100, `trusted` true, `addressPreference` ipv6).
 *
 * Shared with TurboFabric path planning (`planRelayPath`) so the managed
 * ladder and WireGuard endpoint selection can never disagree on which LAN
 * segment a pair may use.
 */
export function partitionSharedDatacenters(
  fromPins: readonly DatacenterMembershipRow[],
  toPins: readonly DatacenterMembershipRow[],
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>
): SharedDatacenterPartition {
  const shared = sharedDatacenterIds(fromPins, toPins)
  const compare = (a: string, b: string): number => {
    const diff =
      policyFor(policiesByDatacenter, a).priority - policyFor(policiesByDatacenter, b).priority
    if (diff !== 0) return diff
    return a.localeCompare(b)
  }
  const trusted: string[] = []
  const untrusted: string[] = []
  for (const datacenterId of shared) {
    if (policyFor(policiesByDatacenter, datacenterId).trusted) {
      trusted.push(datacenterId)
    } else {
      untrusted.push(datacenterId)
    }
  }
  trusted.sort(compare)
  untrusted.sort(compare)
  return { trusted, untrusted }
}

/** What the pair rule reads: datacenter pins, their policies and the daemons that can route over a LAN. */
export type LanPairInputs = {
  membershipsByServer: ReadonlyMap<string, readonly DatacenterMembershipRow[]>
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>
  /** Servers whose daemon lists `fabric-lan-routes-v1`. */
  lanRouteServerIds: ReadonlySet<string>
}

/** Why two servers are not a trusted LAN pair, or null when they are. */
export type TrustedLanBlocker = 'same_server' | 'daemon_too_old' | 'no_trusted_network' | 'no_ipv4'

/**
 * What stops two servers from being a trusted LAN pair: both daemons must
 * route container ranges over a LAN, they must share a trusted datacenter
 * network, and that network must give both an IPv4 address (container
 * forwarding and the daemon's LAN routes are IPv4). Null when nothing does.
 */
export function trustedLanBlocker(
  fromServerId: string,
  toServerId: string,
  inputs: LanPairInputs
): TrustedLanBlocker | null {
  if (fromServerId === toServerId) return 'same_server'
  if (!inputs.lanRouteServerIds.has(fromServerId)) return 'daemon_too_old'
  if (!inputs.lanRouteServerIds.has(toServerId)) return 'daemon_too_old'
  const { trusted } = partitionSharedDatacenters(
    inputs.membershipsByServer.get(fromServerId) ?? [],
    inputs.membershipsByServer.get(toServerId) ?? [],
    inputs.policiesByDatacenter
  )
  if (trusted.length === 0) return 'no_trusted_network'
  // Both directions: each server needs an IPv4 address on the shared network.
  const [first, second] = [fromServerId, toServerId]
  if (!trustedLanIpv4(first, second, inputs)) return 'no_ipv4'
  if (!trustedLanIpv4(second, first, inputs)) return 'no_ipv4'
  return null
}

/**
 * The one pair rule: two different servers share a trusted datacenter network
 * (whatever its link state) that gives both an IPv4 address, and both daemons
 * can route container ranges over it. Such a pair has no tunnel between them;
 * all their traffic, container networks included, rides the LAN. A pair where
 * either daemon is older, or whose shared trusted network is IPv6-only, keeps
 * the tunnel (over the LAN) so it keeps working. Symmetric on purpose: both
 * servers must agree there is no tunnel.
 */
export function serversShareTrustedLan(
  fromServerId: string,
  toServerId: string,
  inputs: LanPairInputs
): boolean {
  return trustedLanBlocker(fromServerId, toServerId, inputs) === null
}

/**
 * `toServerId`'s IPv4 address on the best trusted network it shares with
 * `fromServerId` (networks that are up first, then by priority), with that
 * network's id. IPv4 only: container forwarding and the daemon's LAN routes
 * are IPv4, so an IPv6-only shared network yields null.
 */
export function trustedLanIpv4(
  fromServerId: string,
  toServerId: string,
  inputs: Pick<LanPairInputs, 'membershipsByServer' | 'policiesByDatacenter'>
): { address: string; datacenterId: string } | null {
  const fromPins = inputs.membershipsByServer.get(fromServerId) ?? []
  const toPins = inputs.membershipsByServer.get(toServerId) ?? []
  const { trusted } = partitionSharedDatacenters(fromPins, toPins, inputs.policiesByDatacenter)
  const byLink = splitTrustedByLink(trusted, fromPins, toPins)
  for (const datacenterId of [...byLink.available, ...byLink.down]) {
    if (!familiesInDatacenter(fromPins, datacenterId).has(4)) continue
    const address = pinAddressForDatacenter(fromPins, toPins, datacenterId, 'ipv4')
    if (address && !address.includes(':')) return { address, datacenterId }
  }
  return null
}

export type TrustedByLink = {
  /** Trusted shared datacenters whose NIC link is up on both servers, in the partition's order. */
  available: string[]
  /** Trusted shared datacenters where either server reports the pinned NIC down, same order. */
  down: string[]
}

/**
 * Split the partition's trusted datacenters by link state. A datacenter is
 * down for the pair when any pin of either server in it is flagged
 * `linkDown` (the daemon reported that NIC without a link), whatever the
 * pin's address family: a server whose IPv6 address sits on a down NIC and
 * whose IPv4 address sits on an up NIC in the same datacenter moves the whole
 * network to last resort. (Dual-stack on one NIC is unaffected.) A pin that
 * never reported a link state counts as up, so older daemons behave as before.
 * Both lists keep the `(priority asc, id asc)` order of `trusted`.
 */
export function splitTrustedByLink(
  trusted: readonly string[],
  fromPins: readonly DatacenterMembershipRow[],
  toPins: readonly DatacenterMembershipRow[]
): TrustedByLink {
  const downIds = new Set<string>()
  for (const pin of [...fromPins, ...toPins]) {
    if (pin.linkDown) downIds.add(pin.datacenterId)
  }
  return {
    available: trusted.filter((id) => !downIds.has(id)),
    down: trusted.filter((id) => downIds.has(id)),
  }
}

function unavailablePath(fromServerId: string, toServerId: string): PrivateEndpointError {
  return {
    kind: 'private_path_unavailable',
    fromServerId,
    toServerId,
  }
}

/**
 * Datacenter rung of the ladder: walk only the **trusted** shared datacenters
 * in priority order and return the first family-compatible pin address. A
 * trusted shared datacenter with no common family still reports
 * `private_family_mismatch` (before any fall-through). Untrusted datacenters
 * are never inspected, so they can neither win nor raise a mismatch.
 */
function resolveDatacenterFromCaches(params: {
  fromServerId: string
  toServerId: string
  fromPins: readonly DatacenterMembershipRow[]
  toPins: readonly DatacenterMembershipRow[]
  partition: SharedDatacenterPartition
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>
}): ResolvedPrivateEndpoint | PrivateEndpointError | null {
  const { fromPins, toPins } = params
  let mismatchDatacenterId: string | undefined
  for (const sharedDc of params.partition.trusted) {
    const address = pinAddressForDatacenter(
      fromPins,
      toPins,
      sharedDc,
      policyFor(params.policiesByDatacenter, sharedDc).addressPreference
    )
    if (address) {
      return {
        address,
        transport: 'datacenter',
        datacenterId: sharedDc,
      }
    }
    mismatchDatacenterId ??= sharedDc
  }
  if (mismatchDatacenterId) {
    return {
      kind: 'private_family_mismatch',
      fromServerId: params.fromServerId,
      toServerId: params.toServerId,
      datacenterId: mismatchDatacenterId,
    }
  }
  return null
}

/**
 * The tunnel to `toServerId` can carry traffic: both relays have a key (a
 * keyless relay has no tunnel yet), the other server's daemon is connected,
 * and this relay's live reading shows a recent handshake with it
 * (`pairTunnelHealth` is `healthy`). A relay row alone is not enough: aiming
 * at a `tp0` address with no live tunnel behind it sends traffic nowhere, so
 * the ladder moves on instead. A row read without its key (`undefined`, not
 * loaded) is not judged.
 */
function fabricTunnelUsable(
  from: RelayJoinRow,
  to: RelayJoinRow,
  params: { connectedServerIds?: ReadonlySet<string>; nowMs: number }
): boolean {
  if (from.publicKey === null || to.publicKey === null) return false
  if (params.connectedServerIds && !params.connectedServerIds.has(to.serverId)) return false
  if (to.publicKey === undefined) return true
  return pairTunnelHealth(from.observed, to.publicKey, params.nowMs) === 'healthy'
}

function resolveFabricFromCaches(params: {
  fromServerId: string
  toServerId: string
  relays: RelayJoinRow[]
  connectedServerIds?: ReadonlySet<string>
  nowMs?: number
  /** Fall back to a keyed relay whose tunnel is not healthy, marked `tunnelDown`. */
  allowTunnelDown?: boolean
}): ResolvedPrivateEndpoint | null {
  const usable = {
    ...(params.connectedServerIds ? { connectedServerIds: params.connectedServerIds } : {}),
    nowMs: params.nowMs ?? Date.now(),
  }
  const fromByFabric = new Map(
    params.relays
      .filter((row) => row.serverId === params.fromServerId)
      .map((row) => [row.fabricId, row])
  )
  const sharedOnTo = params.relays
    .filter((row) => {
      const from = fromByFabric.get(row.fabricId)
      return (
        row.serverId === params.toServerId &&
        from !== undefined &&
        fabricTunnelUsable(from, row, usable)
      )
    })
    .sort((a, b) => a.fabricCreatedAt.localeCompare(b.fabricCreatedAt))

  const chosen = sharedOnTo[0]
  if (!chosen) {
    if (!params.allowTunnelDown) return null
    const keyed = params.relays
      .filter((row) => {
        if (row.serverId !== params.toServerId || row.publicKey === null) return false
        const from = fromByFabric.get(row.fabricId)
        return from !== undefined && from.publicKey !== null
      })
      .sort((a, b) => a.fabricCreatedAt.localeCompare(b.fabricCreatedAt))[0]
    if (!keyed) return null
    return {
      address: keyed.address,
      transport: 'fabric',
      fabricId: keyed.fabricId,
      tunnelDown: true,
    }
  }
  return {
    address: chosen.address,
    transport: 'fabric',
    fabricId: chosen.fabricId,
  }
}

type DatacenterResolution = ResolvedPrivateEndpoint | PrivateEndpointError | null

/**
 * The datacenter rung split by link state. A network whose link is down is a
 * last resort, never a first choice: the best network that is up wins by
 * priority, and the ones that are down are only used when nothing else
 * carries the traffic, so a replication path never turns into an error just
 * because a cable was pulled.
 *
 * - `preferred`: the networks that are up. When they only fail on address
 *   family (no family both servers share) but a lower-priority network that
 *   is down is compatible, that network is used (marked `linkDown`) instead of
 *   the mismatch error, as before link state existed.
 * - `lastResort`: the networks that are down, marked `linkDown`.
 */
function datacenterRung(
  resolveAmong: (trusted: string[]) => DatacenterResolution,
  byLink: TrustedByLink
): { preferred: () => DatacenterResolution; lastResort: () => DatacenterResolution } {
  const lastResort = (): DatacenterResolution => {
    const down = resolveAmong(byLink.down)
    if (down === null || 'kind' in down) return down
    return { ...down, linkDown: true }
  }
  const preferred = (): DatacenterResolution => {
    const up = resolveAmong(byLink.available)
    if (up === null || !('kind' in up)) return up
    const fallback = lastResort()
    return fallback !== null && !('kind' in fallback) ? fallback : up
  }
  return { preferred, lastResort }
}

/** Public rung; flagged when the pair shares only untrusted datacenters. */
function publicEndpoint(
  address: string,
  partition: SharedDatacenterPartition
): ResolvedPrivateEndpoint {
  const untrustedOnly = partition.untrusted.length > 0 && partition.trusted.length === 0
  return {
    address,
    transport: 'public',
    ...(untrustedOnly ? { untrustedPublic: true as const } : {}),
  }
}

/**
 * Purpose-aware ladder. Same-host loopback is always first. Cross-host order
 * is inverted from the former fabric-first path: datacenter (LAN) before
 * fabric, then public.
 *
 * The datacenter rung is **trust-gated and priority-ordered**: only shared
 * datacenters with `trusted: true` are candidates, walked in
 * `(priority asc, id asc)` order (see {@link partitionSharedDatacenters}).
 * Untrusted shared datacenters are skipped for every purpose.
 *
 * - `failover-replication`: `local` → `datacenter`, then `fabric` only for a
 *   pair that shares untrusted datacenters (never public). When such a pair
 *   has a keyed tunnel that is not healthy right now (host lost, short gap)
 *   it keeps the fabric address marked `tunnelDown`, so a running cluster is
 *   not broken by a gap; with no keyed tunnel (fabric off, opted out) the error
 *   is `untrusted_network_needs_fabric`; with no shared datacenter at all it
 *   stays `private_path_unavailable`.
 * - `read-replication` / `client-backend`: `local` → `datacenter` → `fabric`
 *   → `public`. The fabric rung is skipped for a pair that shares a trusted
 *   LAN (no tunnel exists between them, {@link serversShareTrustedLan}) and
 *   when the tunnel cannot carry traffic (a keyless relay, the other daemon
 *   offline, or no recent handshake in the live reading); the public
 *   address, then a network that is down, is used instead.
 *
 * A trusted shared-datacenter family mismatch is returned before fabric/public
 * for every purpose.
 */
export function resolveOneFromCaches(params: {
  fromServerId: string
  toServerId: string
  purpose: PrivateEndpointPurpose
  membershipsByServer: Map<string, DatacenterMembershipRow[]>
  relays: RelayJoinRow[]
  policiesByDatacenter: ReadonlyMap<string, DatacenterPolicyRow>
  publicAddressesByServer: Map<string, string>
  /** Servers whose daemon lists `fabric-lan-routes-v1`; absent means none. */
  lanRouteServerIds?: ReadonlySet<string>
  /** Servers whose daemon is connected; absent skips the check. */
  connectedServerIds?: ReadonlySet<string>
  /** Clock for tunnel health; defaults to now. */
  nowMs?: number
}): ResolvedPrivateEndpoint | PrivateEndpointError {
  if (params.fromServerId === params.toServerId) {
    return { address: '127.0.0.1', transport: 'local' }
  }

  const fromPins = params.membershipsByServer.get(params.fromServerId) ?? []
  const toPins = params.membershipsByServer.get(params.toServerId) ?? []
  const partition = partitionSharedDatacenters(fromPins, toPins, params.policiesByDatacenter)
  const byLink = splitTrustedByLink(partition.trusted, fromPins, toPins)
  const rung = datacenterRung(
    (trusted) =>
      resolveDatacenterFromCaches({
        fromServerId: params.fromServerId,
        toServerId: params.toServerId,
        fromPins,
        toPins,
        partition: { ...partition, trusted },
        policiesByDatacenter: params.policiesByDatacenter,
      }),
    byLink
  )

  const datacenter = rung.preferred()
  if (datacenter) return datacenter

  if (params.purpose === 'failover-replication') {
    const fallback = rung.lastResort()
    if (fallback) return fallback
    const untrustedDatacenterId = partition.untrusted[0]
    if (untrustedDatacenterId !== undefined) {
      const viaFabric = resolveFabricFromCaches({ ...params, allowTunnelDown: true })
      if (viaFabric) return viaFabric
      return {
        kind: 'untrusted_network_needs_fabric',
        fromServerId: params.fromServerId,
        toServerId: params.toServerId,
        datacenterId: untrustedDatacenterId,
      }
    }
    return unavailablePath(params.fromServerId, params.toServerId)
  }

  const lanPair = serversShareTrustedLan(params.fromServerId, params.toServerId, {
    membershipsByServer: params.membershipsByServer,
    policiesByDatacenter: params.policiesByDatacenter,
    lanRouteServerIds: params.lanRouteServerIds ?? new Set(),
  })
  const fabricPath = lanPair ? null : resolveFabricFromCaches(params)
  if (fabricPath) return fabricPath

  const publicAddress = params.publicAddressesByServer.get(params.toServerId)
  if (publicAddress) {
    return publicEndpoint(publicAddress, partition)
  }

  return rung.lastResort() ?? unavailablePath(params.fromServerId, params.toServerId)
}

/**
 * Answer "what address does `fromServerId` use to reach `toServerId`?" using
 * the purpose-aware ladder (see {@link resolveOneFromCaches}).
 */
export async function resolvePrivateEndpoint(
  db: Db,
  params: Readonly<{
    fromServerId: string
    toServerId: string
    purpose: PrivateEndpointPurpose
  }>
): Promise<ResolvedPrivateEndpoint | PrivateEndpointError> {
  const results = await resolvePrivateEndpoints(db, {
    fromServerId: params.fromServerId,
    toServerIds: [params.toServerId],
    purpose: params.purpose,
  })
  const value = results.get(params.toServerId)
  if (!value) {
    return unavailablePath(params.fromServerId, params.toServerId)
  }
  return value
}

/** Everything {@link resolveOneFromCaches} reads, for one set of servers. */
export type PrivateEndpointCaches = {
  membershipsByServer: Map<string, DatacenterMembershipRow[]>
  relays: RelayJoinRow[]
  policiesByDatacenter: Map<string, DatacenterPolicyRow>
  publicAddressesByServer: Map<string, string>
  lanRouteServerIds?: Set<string>
  connectedServerIds?: Set<string>
}

async function loadConnectedServerIds(db: Db, serverIds: string[]): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const rows = await db
    .select({ id: server.id, connected: server.isConnected })
    .from(server)
    .where(inArray(server.id, serverIds))
  return new Set(rows.filter((row) => row.connected).map((row) => row.id))
}

/** Membership, relay, public-address, daemon-feature and connection reads, then one policy read. */
export async function loadPrivateEndpointCaches(
  db: Db,
  serverIds: string[]
): Promise<PrivateEndpointCaches> {
  const [membershipsByServer, relays, publicAddressesByServer, lanRouteServerIds, connected] =
    await Promise.all([
      loadDatacenterMembershipsForServers(db, serverIds),
      loadFabricRelayRows(db, serverIds),
      loadPublicAddressesForServers(db, serverIds),
      loadLanRouteServerIds(db, serverIds),
      loadConnectedServerIds(db, serverIds),
    ])
  const datacenterIds = new Set<string>()
  for (const pins of membershipsByServer.values()) {
    for (const pin of pins) datacenterIds.add(pin.datacenterId)
  }
  const policiesByDatacenter = await loadDatacenterPolicies(db, [...datacenterIds])
  return {
    membershipsByServer,
    relays,
    policiesByDatacenter,
    publicAddressesByServer,
    lanRouteServerIds,
    connectedServerIds: connected,
  }
}

/**
 * Batched resolver for one source server → many targets (one membership query,
 * one relay join, one public-address query — no N+1). Relays and public
 * addresses are always loaded; failover-replication simply ignores them.
 */
export async function resolvePrivateEndpoints(
  db: Db,
  params: Readonly<{
    fromServerId: string
    toServerIds: readonly string[]
    purpose: PrivateEndpointPurpose
  }>
): Promise<Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>> {
  const out = new Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>()
  if (params.toServerIds.length === 0) return out

  const uniqueTargets = [...new Set(params.toServerIds)]
  const allServerIds = [...new Set([params.fromServerId, ...uniqueTargets])]
  const caches = await loadPrivateEndpointCaches(db, allServerIds)

  for (const toServerId of uniqueTargets) {
    out.set(
      toServerId,
      resolveOneFromCaches({
        fromServerId: params.fromServerId,
        toServerId,
        purpose: params.purpose,
        ...caches,
      })
    )
  }
  return out
}
