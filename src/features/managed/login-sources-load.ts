/**
 * Database lookups for per-login host limits: which servers a request may
 * name, and the addresses each named server answers on.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { fabric, ip, relay, server } from '../../db/schema.ts'
import { reportedIpsFromServerMetadata } from '../../contracts/server-addresses.ts'
import { inetAddressToString } from '../../lib/ip-address.ts'
import { relayCarriesTraffic } from '../fabric/relay-filters.ts'
import { organizationRootAllowedSources } from './root-login-sources.ts'

/** The ids among `serverIds` that belong to `organizationId`. */
export async function findOrganizationServerIds(
  db: Db,
  organizationId: string,
  serverIds: readonly string[]
): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const rows = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.organizationId, organizationId), inArray(server.id, [...serverIds])))
  return new Set(rows.map((row) => row.id))
}

/** Every routable address (public, private network, mesh) of each given server. */
export async function loadServerAddressMap(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (serverIds.length === 0) return result
  const ids = [...new Set(serverIds)]
  const [servers, ipRows, relayRows] = await Promise.all([
    db
      .select({ id: server.id, metadata: server.metadata })
      .from(server)
      .where(inArray(server.id, ids)),
    db
      .select({ serverId: ip.serverId, address: ip.address })
      .from(ip)
      .where(inArray(ip.serverId, ids)),
    db
      .select({ serverId: relay.serverId, address: relay.address })
      .from(relay)
      .innerJoin(fabric, eq(relay.fabricId, fabric.id))
      .where(and(inArray(relay.serverId, ids), relayCarriesTraffic())),
  ])
  for (const row of servers) {
    result.set(
      row.id,
      organizationRootAllowedSources({
        reported: reportedIpsFromServerMetadata(row.metadata) ?? [],
        stored: ipRows
          .filter((r) => r.serverId === row.id)
          .map((r) => inetAddressToString(r.address) ?? ''),
        mesh: relayRows
          .filter((r) => r.serverId === row.id)
          .map((r) => inetAddressToString(r.address) ?? ''),
      })
    )
  }
  return result
}
