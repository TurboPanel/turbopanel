/**
 * DB-free helpers for ProxySQL ingress desired-state assembly.
 *
 * Kept separate from {@link ./ingress-desired.ts} so host-free Deno suites can
 * cover protocol/SAN/bind/backend decision logic without Postgres.
 */

import type { ManagedIngressReconcileBackend } from '../../contracts/commands/schemas.ts'
import { ALL_INTERFACES_BIND, LOOPBACK_BIND } from './access-address.ts'
import {
  DEFAULT_MANAGED_INGRESS_PORTS,
  type ManagedIngressFamily,
  managedIngressFamilyForEngine,
  managedIngressPortForEngine,
  type ManagedIngressPorts,
} from './ingress-ports.ts'
import { type ManagedSslMode, managedSslRequiresTls, resolveManagedSslMode } from './ssl.ts'

export {
  DEFAULT_MANAGED_INGRESS_PORTS,
  MANAGED_INGRESS_MYSQL_PORT,
  MANAGED_INGRESS_PGSQL_PORT,
  managedIngressFamilyForEngine,
  managedIngressPortForEngine,
  resolveManagedIngressPorts,
} from './ingress-ports.ts'

// Wildcard "any interface" bind markers — listen-address sentinels, never
// real endpoints to advertise as a SAN.
export const WILDCARD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '::0']) // NOSONAR typescript:S1313 — wildcard bind sentinel, not a routable address

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

export function isIngressRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Wire `protocolPort` + `family` for a cluster.
 *
 * Both travel together because the daemon must not re-derive a protocol family
 * from a number an operator chose: with configurable listeners, `13306` is only
 * MySQL by convention.
 */
export function protocolListenerForEngine(
  engine: string,
  defaultPort: number,
  ports: ManagedIngressPorts = DEFAULT_MANAGED_INGRESS_PORTS
): { protocolPort: number; family: ManagedIngressFamily } {
  return {
    protocolPort: managedIngressPortForEngine(engine, defaultPort, ports),
    family: managedIngressFamilyForEngine(engine, defaultPort),
  }
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
    (entry): entry is string => typeof entry === 'string' && entry.length > 0
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

export function addSanValue(value: string, dnsNames: Set<string>, ipAddresses: Set<string>): void {
  if (looksLikeIpLiteral(value)) ipAddresses.add(value)
  else dnsNames.add(value)
}

export function addBindAddressSan(
  bindAddress: string | undefined,
  dnsNames: Set<string>,
  ipAddresses: Set<string>
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
  ipAddresses: Set<string>
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
  /**
   * Every address the frontend publishes on. All of them are dial targets, so
   * all of them need a SAN or `verify-full` fails on whichever one the client
   * happened to pick.
   */
  bindAddresses: readonly string[]
  backendAddresses: readonly string[]
}): { dnsNames: string[]; ipAddresses: string[] } {
  const dnsNames = new Set<string>()
  const ipAddresses = new Set<string>()
  const hostname = params.hostname?.trim()
  if (hostname) addSanValue(hostname, dnsNames, ipAddresses)
  for (const address of params.bindAddresses) {
    addBindAddressSan(address, dnsNames, ipAddresses)
  }
  for (const address of params.backendAddresses) {
    addBackendAddressSan(address, dnsNames, ipAddresses)
  }
  return {
    dnsNames: [...dnsNames].sort((a, b) => a.localeCompare(b)),
    ipAddresses: [...ipAddresses].sort((a, b) => a.localeCompare(b)),
  }
}

/**
 * Host addresses the server's shared ProxySQL publishes its client listeners on.
 *
 * - external access **off** (the default): loopback only. Sites run by a site
 *   owner's Linux user dial `127.0.0.1`; loopback is not exposure, nothing off
 *   the machine can reach it. Bound containers need no publish at all (they
 *   dial ProxySQL by name over the managed Docker network).
 * - external access **on**: every address of the server (`0.0.0.0`).
 *
 * Never empty here: a server with no cluster to front never reaches this
 * decision (the reconcile is `not_needed` or a teardown). **The publish is the
 * enforcement**: the host firewall only previews these listeners so far, and
 * ProxySQL has no per-user source ACL, so "off" must stay loopback and must
 * never widen to a wildcard.
 */
export function decideIngressBindAddresses(externalAccess: boolean): string[] {
  return [externalAccess ? ALL_INTERFACES_BIND : LOOPBACK_BIND]
}

/**
 * Addresses the proxy's certificate must name for its published listeners. A
 * site run by a site owner's Linux user verifies the certificate against
 * `127.0.0.1`, and under an all-interfaces publish the bind is a wildcard that
 * carries no SAN of its own, so loopback is always named explicitly.
 */
export function sanBindAddresses(bindAddresses: readonly string[]): string[] {
  return bindAddresses.includes(LOOPBACK_BIND)
    ? [...bindAddresses]
    : [...bindAddresses, LOOPBACK_BIND]
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
 * Co-resident member → Docker container name on the organization's managed network.
 * Remote members need a private port + endpoint resolution (caller).
 */
export function buildLocalOrMissingPortBackend(
  fromServerId: string,
  member: LocalBackendMember,
  enginePort: number
): IngressBackendBuildResult | { kind: 'remote'; role: 'primary' | 'replica' } {
  const role: 'primary' | 'replica' = member.role === 'replica' ? 'replica' : 'primary'

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
  containerName: string
): { dnsNames: string[]; ipAddresses: string[] } {
  return {
    dnsNames: [...new Set([...listenerSans.dnsNames, containerName])].sort((a, b) =>
      a.localeCompare(b)
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

/**
 * Frontend hostgroup default for a managed login.
 *
 * Returns `undefined` for the implicit `read-write` default so the wire payload
 * stays minimal. Only an explicit `connectionRole: 'read-only'` on the
 * principal metadata moves a login to the reader hostgroup — read eligibility
 * of a member never rewrites where an existing login sends its traffic.
 */
export function principalConnectionRole(metadata: unknown): 'read-only' | undefined {
  if (!isIngressRecord(metadata)) return undefined
  return metadata.connectionRole === 'read-only' ? 'read-only' : undefined
}

/** Cluster-level `^SELECT` split policy; absent/false keeps reads on the primary. */
export function clusterAutoReadSplit(routing: { autoReadSplit?: boolean } | undefined): boolean {
  return routing?.autoReadSplit === true
}

/**
 * Whether ProxySQL must refuse unencrypted client sessions for this cluster.
 *
 * Frontend TLS is a cluster policy even though ProxySQL spells it per user row
 * (`use_ssl`), so it is resolved once here — service override → org default →
 * platform `require` — and the daemon applies it to every login of the cluster.
 * Backend (ProxySQL → engine) TLS is unconditional and unaffected.
 */
export function clusterRequireTls(
  configured: ManagedSslMode | undefined,
  organizationDefault: ManagedSslMode | undefined
): boolean {
  return managedSslRequiresTls(resolveManagedSslMode(configured, organizationDefault))
}

export function shouldSkipIngressFrontendUser(username: unknown, metadata: unknown): boolean {
  if (typeof username !== 'string' || username.length === 0) return true
  // Replication principal is not a client login — never a ProxySQL frontend user.
  if (isManagedReplicationPrincipal(metadata)) return true
  return false
}

export function isAtRestSealedPassword(sealed: unknown, envelopePrefix: string): sealed is string {
  return typeof sealed === 'string' && sealed.startsWith(envelopePrefix)
}
