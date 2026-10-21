/**
 * Where a managed cluster's root login may be used from, as seen by the shared
 * ProxySQL on a server.
 *
 * The root login is a full superuser, so ProxySQL refuses its queries unless
 * they come from the server itself, its containers, or the organization's
 * servers. This module builds the "organization's servers" part: every address
 * the organization's servers can reach this one from — public addresses,
 * the private network between servers (datacenter addresses) and the
 * TurboFabric mesh address. The daemon adds the server's own loopback and
 * Docker network sources itself (it alone knows the live subnets).
 *
 * Sent as `allowedSources` on each root user of `managed.ingress.reconcile`.
 * Absent means "no limit" to the daemon, so an older daemon keeps today's
 * behaviour.
 */

import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { fabric, ip, relay, server } from '../../db/schema.ts'
import { reportedIpsFromServerMetadata } from '../../contracts/server-addresses.ts'
import {
  inetAddressToString,
  isRoutableHostAddress,
  normalizeIpAddress,
} from '../../lib/ip-address.ts'

/** Docker's own bridges and the container ends of their links. */
const DOCKER_INTERFACE_RE = /^(docker\d|br-|veth)/

/** Most addresses sent per root login (the daemon refuses more). */
export const MAX_ROOT_ALLOWED_SOURCES = 1024

type ReportedAddress = { address: string; interface?: string }

export type OrganizationServerAddressFacts = {
  /** Addresses the daemons of the organization's servers reported on their interfaces. */
  reported: readonly ReportedAddress[]
  /** Stored `ip` rows of those servers (public and datacenter). */
  stored: readonly string[]
  /** TurboFabric mesh addresses of those servers. */
  mesh: readonly string[]
}

/**
 * Plain, sorted, de-duplicated host addresses. Loopback, link-local and
 * Docker-bridge addresses are dropped: they say nothing about another server,
 * and a Docker bridge address is the same on every host.
 */
export function organizationRootAllowedSources(facts: OrganizationServerAddressFacts): string[] {
  const out = new Set<string>()
  const add = (value: unknown) => {
    const address = normalizeIpAddress(value)
    if (address !== null && isRoutableHostAddress(address)) out.add(address)
  }
  for (const row of facts.reported) {
    if (DOCKER_INTERFACE_RE.test(row.interface ?? '')) continue
    add(row.address)
  }
  for (const address of facts.stored) add(address)
  for (const address of facts.mesh) add(address)
  return [...out].sort((a, b) => a.localeCompare(b)).slice(0, MAX_ROOT_ALLOWED_SOURCES)
}

/** Load every address of every server of `organizationId` (the server owner's organization). */
export async function loadOrganizationRootAllowedSources(
  db: Db,
  organizationId: string
): Promise<string[]> {
  const servers = await db
    .select({ id: server.id, metadata: server.metadata })
    .from(server)
    .where(eq(server.organizationId, organizationId))
  if (servers.length === 0) return []
  const serverIds = servers.map((row) => row.id)
  const [ipRows, relayRows] = await Promise.all([
    db.select({ address: ip.address }).from(ip).where(inArray(ip.serverId, serverIds)),
    db
      .select({ address: relay.address })
      .from(relay)
      .innerJoin(fabric, eq(relay.fabricId, fabric.id))
      .where(inArray(relay.serverId, serverIds)),
  ])
  return organizationRootAllowedSources({
    reported: servers.flatMap((row) => reportedIpsFromServerMetadata(row.metadata) ?? []),
    stored: ipRows.map((row) => inetAddressToString(row.address) ?? ''),
    mesh: relayRows.map((row) => inetAddressToString(row.address) ?? ''),
  })
}
