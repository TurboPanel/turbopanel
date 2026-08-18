/**
 * DB-free helpers for ProxySQL ingress desired-state assembly.
 *
 * Kept separate from {@link ./ingress-desired.ts} so host-free Deno suites can
 * cover protocol/SAN/bind/backend decision logic without Postgres.
 */

import type { HostingBindScope } from '../../lib/hosting-options.ts'
import type { ManagedIngressReconcileBackend } from '../../lib/commands/schemas.ts'
import {
  managedIngressPortForEngine,
  type ManagedIngressListenerPort,
} from '../../lib/managed/ingress-ports.ts'

export {
  MANAGED_INGRESS_LISTENER_PORTS,
  MANAGED_INGRESS_MYSQL_PORT,
  MANAGED_INGRESS_PGSQL_PORT,
  managedIngressFamilyForPort,
  managedIngressPortForEngine,
} from '../../lib/managed/ingress-ports.ts'

// Wildcard "any interface" bind markers — listen-address sentinels, never
// real endpoints to advertise as a SAN.
export const WILDCARD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '::0']) // NOSONAR typescript:S1313 — wildcard bind sentinel, not a routable address

const BIND_RANK: Record<HostingBindScope, number> = {
  local: 1,
  datacenter: 2,
  public: 3,
}

/** Hostgroup pair for cluster index `i` (stable writer = 2i, reader = 2i+1). */
export function hostgroupsForClusterIndex(index: number): {
  writerHostgroup: number
  readerHostgroup: number
} {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(`Invalid cluster index: ${index}`)
  }
  return {
    writerHostgroup: index * 2,
    readerHostgroup: index * 2 + 1,
  }
}

/**
 * Union of enabled exposure binds to the most permissive scope
 * (public > datacenter > local). Returns `undefined` when every cluster has
 * exposure disabled.
 */
export function unionExposureBind(
  binds: readonly (HostingBindScope | undefined)[],
): HostingBindScope | undefined {
  let best: HostingBindScope | undefined
  let bestRank = 0
  for (const bind of binds) {
    if (bind === undefined) continue
    const rank = BIND_RANK[bind] ?? 0
    if (rank > bestRank) {
      best = bind
      bestRank = rank
    }
  }
  return best
}

export function isIngressRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function protocolPortForEngine(
  engine: string,
  defaultPort: number,
): ManagedIngressListenerPort {
  return managedIngressPortForEngine(engine, defaultPort)
}

export function isManagedRootPrincipal(metadata: unknown): boolean {
  if (!isIngressRecord(metadata)) return false
  return metadata.managedRoot === true
}

export function isManagedReplicationPrincipal(metadata: unknown): boolean {
  if (!isIngressRecord(metadata)) return false
  return metadata.managedReplication === true
}

export function principalDefaultDatabase(metadata: unknown): string | undefined {
  if (!isIngressRecord(metadata)) return undefined
  if (!Array.isArray(metadata.databases)) return undefined
  const first = metadata.databases.find(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  return first
}

export function looksLikeIpLiteral(value: string): boolean {
  if (value.includes(':')) return true // IPv6 or bracketed form
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false
    const n = Number(p)
    return n >= 0 && n <= 255
  })
}

export function addSanValue(
  value: string,
  dnsNames: Set<string>,
  ipAddresses: Set<string>,
): void {
  if (looksLikeIpLiteral(value)) ipAddresses.add(value)
  else dnsNames.add(value)
}

export function addBindAddressSan(
  bindAddress: string | undefined,
  dnsNames: Set<string>,
  ipAddresses: Set<string>,
): void {
  if (!bindAddress) return
  if (!looksLikeIpLiteral(bindAddress)) {
    dnsNames.add(bindAddress)
    return
  }
  if (WILDCARD_BIND_ADDRESSES.has(bindAddress)) return
  ipAddresses.add(bindAddress)
}

export function addBackendAddressSan(
  address: string,
  dnsNames: Set<string>,
  ipAddresses: Set<string>,
): void {
  if (!address || address.length === 0) return
  // Co-resident container names are not client dial targets.
  if (!looksLikeIpLiteral(address) && !address.includes('.')) return
  addSanValue(address, dnsNames, ipAddresses)
}

/**
 * Collect DNS + IP SANs that clients are told to dial for this server's
 * ProxySQL — hostname, bind address, and remote peer endpoints used by backends.
 * Synthetic names (leaf CN) stay additional SANs only via the builder.
 */
export function collectProxySqlListenerSans(params: {
  hostname: string | null | undefined
  bindAddress: string | undefined
  backendAddresses: readonly string[]
}): { dnsNames: string[]; ipAddresses: string[] } {
  const dnsNames = new Set<string>()
  const ipAddresses = new Set<string>()
  const hostname = params.hostname?.trim()
  if (hostname) addSanValue(hostname, dnsNames, ipAddresses)
  addBindAddressSan(params.bindAddress, dnsNames, ipAddresses)
  for (const address of params.backendAddresses) {
    addBackendAddressSan(address, dnsNames, ipAddresses)
  }
  return {
    dnsNames: [...dnsNames].sort((a, b) => a.localeCompare(b)),
    ipAddresses: [...ipAddresses].sort((a, b) => a.localeCompare(b)),
  }
}

/**
 * Pure bind-scope decision for shared ProxySQL publish — never let an
 * ambiguous `undefined` mean two different things.
 *
 * - No enabled exposure → omit bindAddress (daemon publishes nothing)
 * - `public` → explicit all-interfaces (`0.0.0.0`) without hosting IP-pin lookup
 * - `local` / `datacenter` → caller must resolve via hosting-bind helper
 */
export type IngressBindScopeDecision =
  | { kind: 'omit' }
  | { kind: 'public_all_interfaces'; address: '0.0.0.0' }
  | { kind: 'resolve'; bind: Exclude<HostingBindScope, 'public'> }

export function decideIngressBindScope(
  enabledBinds: readonly (HostingBindScope | undefined)[],
): IngressBindScopeDecision {
  const bindScope = unionExposureBind(enabledBinds)
  if (bindScope === undefined) return { kind: 'omit' }
  if (bindScope === 'public') {
    return { kind: 'public_all_interfaces', address: '0.0.0.0' } // NOSONAR typescript:S1313 — explicit all-interfaces publish
  }
  return { kind: 'resolve', bind: bindScope }
}

export type LocalBackendMember = {
  memberId: string
  serverId: string
  role: string
  readEligible: boolean
  containerName: string | null
  privatePort: number | null
}

export type IngressBackendBuildResult =
  | { kind: 'ok'; backend: ManagedIngressReconcileBackend }
  | {
    kind: 'private_path_unavailable'
    fromServerId: string
    toServerId: string
  }

/**
 * Co-resident member → Docker container name on `turbopanel-managed`.
 * Remote members need a private port + endpoint resolution (caller).
 */
export function buildLocalOrMissingPortBackend(
  fromServerId: string,
  member: LocalBackendMember,
  enginePort: number,
): IngressBackendBuildResult | { kind: 'remote'; role: 'primary' | 'replica' } {
  const role: 'primary' | 'replica' =
    member.role === 'replica' ? 'replica' : 'primary'

  if (member.serverId === fromServerId) {
    const address = member.containerName
    if (!address) {
      return {
        kind: 'private_path_unavailable',
        fromServerId,
        toServerId: member.serverId,
      }
    }
    return {
      kind: 'ok',
      backend: {
        memberId: member.memberId,
        role,
        readEligible: member.readEligible,
        address,
        port: enginePort,
        transport: 'local',
      },
    }
  }

  if (member.privatePort === null) {
    return {
      kind: 'private_path_unavailable',
      fromServerId,
      toServerId: member.serverId,
    }
  }

  return { kind: 'remote', role }
}

export function buildRemoteIngressBackend(params: {
  memberId: string
  role: 'primary' | 'replica'
  readEligible: boolean
  address: string
  privatePort: number
  transport: ManagedIngressReconcileBackend['transport']
}): ManagedIngressReconcileBackend {
  return {
    memberId: params.memberId,
    role: params.role,
    readEligible: params.readEligible,
    address: params.address,
    port: params.privatePort,
    transport: params.transport,
  }
}

export function mergeHierarchyContainerSan(
  listenerSans: { dnsNames: string[]; ipAddresses: string[] },
  containerName: string,
): { dnsNames: string[]; ipAddresses: string[] } {
  return {
    dnsNames: [...new Set([...listenerSans.dnsNames, containerName])].sort(
      (a, b) => a.localeCompare(b),
    ),
    ipAddresses: listenerSans.ipAddresses,
  }
}

export function sortManagedIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function buildIngressUserRole(metadata: unknown): 'root' | 'user' {
  return isManagedRootPrincipal(metadata) ? 'root' : 'user'
}

export function shouldSkipIngressFrontendUser(
  username: unknown,
  metadata: unknown,
): boolean {
  if (typeof username !== 'string' || username.length === 0) return true
  // Replication principal is not a client login — never a ProxySQL frontend user.
  if (isManagedReplicationPrincipal(metadata)) return true
  return false
}

export function isAtRestSealedPassword(
  sealed: unknown,
  envelopePrefix: string,
): sealed is string {
  return typeof sealed === 'string' && sealed.startsWith(envelopePrefix)
}
