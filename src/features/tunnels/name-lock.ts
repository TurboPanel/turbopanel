/**
 * The deploy-time lock on tunnel names (`hostings[].tunnel`). A name that
 * belongs to a tunnel runs on this server, so its site block answers only the
 * local connector and the servers that forward to it; everyone else is
 * dropped. A name that is also public (its doorway is not local-only) stays
 * open to everyone. Servers that forward here are the other servers that carry
 * the same tunnel, by their exact datacenter addresses.
 */
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { doorway } from '../../db/schema.ts'
import type { EnvironmentDeployHostingTunnel } from '../../contracts/commands/tunnel-routes.ts'
import { hostingCertificateNames, type HostingWwwMode } from '../../contracts/commands/hostname.ts'
import { TUNNEL_TABLE_CAPS } from './route-builder.ts'
import { compareText } from './order.ts'
import { daemonCanCarryTunnels } from './daemon-gate.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { carryingServers, listTunnels } from './lifecycle.ts'
import { loadServerAddresses } from './route-facts.ts'

/** Always allowed anyway; sent when no other server forwards here so the list is never empty. */
export const LOOPBACK_PEER = '127.0.0.1'

export type NameLockDoorway = {
  hostname: string
  tunnelId: string
  isLocalOnly: boolean
}

export type NameLockInput = {
  /** The hosting's own names, as the deploy sends them. */
  siteHostnames: readonly string[]
  doorways: readonly NameLockDoorway[]
  /** Servers that carry each tunnel right now. */
  carryingByTunnel: ReadonlyMap<string, readonly string[]>
  /** This server and its exact datacenter addresses. */
  serverId: string
  addresses: ReadonlyMap<string, readonly string[]>
}

export type NameLock = {
  /** Names that stay locked to local and peer visitors. */
  lockedHostnames: string[]
  /** What the deploy sends; absent when the hosting carries no tunnel name. */
  tunnel: EnvironmentDeployHostingTunnel | undefined
}

/** Peers first, in a stable order, cut at the contract cap. */
function peerAddressesOf(input: NameLockInput, tunnelIds: ReadonlySet<string>): string[] {
  const peers = new Set<string>()
  for (const tunnelId of tunnelIds) {
    for (const carrier of input.carryingByTunnel.get(tunnelId) ?? []) {
      if (carrier === input.serverId) continue
      for (const address of input.addresses.get(carrier) ?? []) peers.add(address)
    }
  }
  return [...peers].toSorted(compareText).slice(0, TUNNEL_TABLE_CAPS.addresses)
}

export function buildNameLock(input: NameLockInput): NameLock {
  const siteByLower = new Map(input.siteHostnames.map((name) => [name.toLowerCase(), name]))
  const names = new Map<string, NameLockDoorway>()
  for (const d of input.doorways) {
    const site = siteByLower.get(d.hostname.toLowerCase())
    if (site !== undefined && !names.has(site)) names.set(site, d)
  }
  if (names.size === 0) return { lockedHostnames: [], tunnel: undefined }
  const hostnames = [...names.keys()].toSorted(compareText)
  const open = hostnames.filter((name) => names.get(name)?.isLocalOnly === false)
  const locked = hostnames.filter((name) => !open.includes(name))
  const tunnelIds = new Set([...names.values()].map((d) => d.tunnelId))
  const peers = peerAddressesOf(input, tunnelIds)
  const tunnel: EnvironmentDeployHostingTunnel = {
    hostnames,
    peers: peers.length > 0 ? peers : [LOOPBACK_PEER],
  }
  if (open.length > 0) tunnel.openHostnames = open
  // Peers reach this server on its own datacenter addresses.
  const own = [...(input.addresses.get(input.serverId) ?? [])].slice(0, TUNNEL_TABLE_CAPS.addresses)
  if (peers.length > 0 && own.length > 0) tunnel.extraBind = own
  return { lockedHostnames: locked, tunnel }
}

/**
 * A doorway with no site yet whose name the deploying hosting lists. A name may
 * be put on a tunnel before the site has it, and the link to the site is only
 * filled in after a deploy (by the sweep and the resend), so the first deploy
 * finds the doorway by the name instead. Read only: a doorway already linked to
 * another site is never taken, and nothing is written from a deploy preparation.
 */
function unlinkedDoorwayNamed(siteHostnames: readonly string[]) {
  const names = [...new Set(siteHostnames.map((name) => name.toLowerCase()))]
  return and(
    sql`${doorway.hostingId} IS NULL`,
    names.length > 0 ? inArray(sql`lower(${doorway.hostname})`, names) : sql`false`
  )
}

/** The organization's live doorways for a hosting: linked to it, or unlinked and named by it. */
async function loadDoorwayRows(
  db: Db,
  params: { organizationId: string; hostingId: string; siteHostnames: readonly string[] }
): Promise<NameLockDoorway[]> {
  return await db
    .select({
      hostname: doorway.hostname,
      tunnelId: doorway.tunnelId,
      isLocalOnly: doorway.isLocalOnly,
    })
    .from(doorway)
    .where(
      and(
        eq(doorway.routingOrganizationId, params.organizationId),
        ne(doorway.status, 'removing'),
        or(eq(doorway.hostingId, params.hostingId), unlinkedDoorwayNamed(params.siteHostnames))
      )
    )
}

/** The lock for one hosting of an organization on one server. Hostings with no doorway cost one query. */
export async function loadNameLock(
  db: Db,
  params: {
    organizationId: string
    serverId: string
    hostingId: string
    siteHostnames: readonly string[]
  }
): Promise<NameLock> {
  const rows = await loadDoorwayRows(db, params)
  if (rows.length === 0) return { lockedHostnames: [], tunnel: undefined }
  const tunnelIds = new Set(rows.map((r) => r.tunnelId))
  const tunnels = (await listTunnels(db, params.organizationId)).filter((t) => tunnelIds.has(t.id))
  const carrying = await Promise.all(tunnels.map((t) => carryingServers(db, t)))
  const carryingByTunnel = new Map(tunnels.map((t, index) => [t.id, carrying[index] ?? []]))
  const involved = [...new Set([params.serverId, ...carrying.flat()])]
  const addresses = await loadServerAddresses(db, params.organizationId, involved)
  return buildNameLock({
    siteHostnames: params.siteHostnames,
    doorways: rows.filter((r) => carryingByTunnel.has(r.tunnelId)),
    carryingByTunnel,
    serverId: params.serverId,
    addresses,
  })
}

export type NameLockRefusal = {
  /** `tunnel_daemon_too_old`: the server's daemon would serve a locked name to anyone. `tunnel_name_public_certificate`: a locked name is pinned to a public certificate. */
  code: 'tunnel_daemon_too_old' | 'tunnel_name_public_certificate'
  hostnames: string[]
}

/**
 * Is every name the hosting's certificate would cover a locked tunnel name?
 * That is the typed names and, under a `www` mode, their other spelling, served
 * or only redirected. The other spelling is never a tunnel name unless it was
 * typed too, so it counts as an ordinary public name. Compared without case.
 */
export function everyNameLocked(
  siteHostnames: readonly string[],
  www: HostingWwwMode | undefined,
  locked: readonly string[]
): boolean {
  const lockedLower = new Set(locked.map((name) => name.toLowerCase()))
  return hostingCertificateNames({ hostnames: siteHostnames, www }).every((name) =>
    lockedLower.has(name.toLowerCase())
  )
}

export type DeployNameLock = {
  tunnel: EnvironmentDeployHostingTunnel | undefined
  /** The hosting was pinned to a public certificate; its names are all tunnel-only, so it deploys on the internal one. */
  dropPublicCertificate?: true
}

/**
 * What a deploy sends as `hostings[].tunnel`, or why it must be refused. An
 * older daemon would serve a locked name to everyone, so a hosting with a
 * locked name waits until the server's daemon carries tunnels; a hosting whose
 * names are all public needs nothing from it.
 *
 * A tunnel block never asks for a public certificate, and a public certificate
 * is one choice for the whole hosting. When every name the hosting serves is a
 * locked tunnel name, a Let's Encrypt pin (the box that switches on by itself
 * when a hostname is typed) is set aside and the hosting deploys on the
 * internal certificate: nothing else could have used it. When the hosting also
 * serves ordinary public names, the pin cannot be set aside, and the deploy is
 * refused with the locked names so the owner can choose.
 */
export async function resolveDeployNameLock(
  db: Db,
  params: {
    organizationId: string
    serverId: string
    hostingId: string
    siteHostnames: readonly string[]
    /** The hosting's `www` mode: the other spelling of each name is served or redirected too. */
    www?: HostingWwwMode
    tlsMode: 'acme' | undefined
  }
): Promise<DeployNameLock | { refusal: NameLockRefusal }> {
  const lock = await loadNameLock(db, params)
  if (lock.tunnel === undefined) return { tunnel: undefined }
  const locked = lock.lockedHostnames
  const acmePinned = params.tlsMode === 'acme' && locked.length > 0
  if (acmePinned && !everyNameLocked(params.siteHostnames, params.www, locked)) {
    return { refusal: { code: 'tunnel_name_public_certificate', hostnames: locked } }
  }
  const state = await getServerDaemonStateByServerId(db, params.serverId)
  if (!daemonCanCarryTunnels(state?.projection?.features)) {
    if (locked.length === 0) return { tunnel: undefined }
    return { refusal: { code: 'tunnel_daemon_too_old', hostnames: locked } }
  }
  return { tunnel: lock.tunnel, ...(acmePinned ? { dropPublicCertificate: true as const } : {}) }
}

/**
 * Is every name this hosting serves (typed names and their `www` spelling) a
 * locked tunnel name? Then nothing public can use a certificate for it: the
 * edge ends TLS and the server uses its internal one. Read only.
 */
export async function isTunnelOnlyHosting(
  db: Db,
  params: {
    organizationId: string
    hostingId: string
    siteHostnames: readonly string[]
    www?: HostingWwwMode
  }
): Promise<boolean> {
  if (params.siteHostnames.length === 0) return false
  const rows = await loadDoorwayRows(db, params)
  const siteLower = new Set(params.siteHostnames.map((name) => name.toLowerCase()))
  const locked = rows
    .filter((row) => row.isLocalOnly && siteLower.has(row.hostname.toLowerCase()))
    .map((row) => row.hostname)
  return locked.length > 0 && everyNameLocked(params.siteHostnames, params.www, locked)
}
