/**
 * How visitors reach a hosting through a tunnel, for the hosting reads. Each
 * entry is one of the hosting's names that a tunnel carries: which tunnel,
 * whether the name is tunnel-only (no public path) and whether the connector
 * checks the server's certificate. The connector checks it only while the
 * tunnel's verified connection is in effect (`VerifyState.active`, the same
 * value the routes sent to the provider use); otherwise it reaches the server
 * over HTTPS and accepts the server's own certificate on purpose.
 *
 * Doorways are matched the way a deploy matches them: linked to the hosting,
 * or not linked yet and named by it.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { doorway, tunnel } from '../../db/schema.ts'
import { parseHostingOptions } from '../hostings/hosting-options.ts'
import { unlinkedDoorwayNamed } from './name-lock.ts'
import { compareText } from './order.ts'
import { tunnelVerifyState } from './verify-state.ts'

export type HostingTunnelPath = {
  hostname: string
  tunnelId: string
  tunnelName: string
  provider: string
  /** True: only the tunnel reaches this name. False: it is also served directly. */
  tunnelOnly: boolean
  /** True: the connector checks the server's certificate. False: it accepts the server's own certificate. */
  originVerified: boolean
  /** The doorway's state: `pending`, `live` or `attention`. */
  status: string
}

export type HostingTunnelDoorway = {
  hostname: string
  hostingId: string | null
  tunnelId: string
  tunnelName: string
  provider: string
  isLocalOnly: boolean
  status: string
}

type HostingNames = { id: string; hostnames: readonly string[] }

/**
 * The tunnel paths of each hosting, from the organization's live doorways. A
 * doorway linked to a hosting belongs to it; one not linked yet belongs to the
 * hosting that lists its name. Hostings with no tunnel name are left out.
 */
export function matchHostingTunnelPaths(
  hostings: readonly HostingNames[],
  doorways: readonly HostingTunnelDoorway[],
  verifiedTunnels: ReadonlySet<string>
): Map<string, HostingTunnelPath[]> {
  const result = new Map<string, HostingTunnelPath[]>()
  for (const row of hostings) {
    const names = new Set(row.hostnames.map((name) => name.toLowerCase()))
    const paths = doorways
      .filter((d) =>
        d.hostingId === null ? names.has(d.hostname.toLowerCase()) : d.hostingId === row.id
      )
      .map((d) => ({
        hostname: d.hostname,
        tunnelId: d.tunnelId,
        tunnelName: d.tunnelName,
        provider: d.provider,
        tunnelOnly: d.isLocalOnly,
        originVerified: verifiedTunnels.has(d.tunnelId),
        status: d.status,
      }))
      .toSorted((a, b) => compareText(a.hostname, b.hostname))
    if (paths.length > 0) result.set(row.id, paths)
  }
  return result
}

/** The tunnel paths of the given hostings of one organization. No doorway costs one query. */
export async function loadHostingTunnelPaths(
  db: Db,
  organizationId: string,
  rows: readonly { id: string; options: unknown }[],
  now: Date = new Date()
): Promise<Map<string, HostingTunnelPath[]>> {
  if (rows.length === 0) return new Map()
  const hostings = rows.map((row) => ({
    id: row.id,
    hostnames: parseHostingOptions(row.options)?.hostnames ?? [],
  }))
  const doorways = await db
    .select({
      hostname: doorway.hostname,
      hostingId: doorway.hostingId,
      tunnelId: doorway.tunnelId,
      tunnelName: tunnel.name,
      provider: tunnel.provider,
      tunnelOptions: tunnel.options,
      isLocalOnly: doorway.isLocalOnly,
      status: doorway.status,
    })
    .from(doorway)
    .innerJoin(tunnel, eq(tunnel.id, doorway.tunnelId))
    .where(
      and(
        eq(doorway.routingOrganizationId, organizationId),
        ne(doorway.status, 'removing'),
        or(
          inArray(
            doorway.hostingId,
            hostings.map((row) => row.id)
          ),
          unlinkedDoorwayNamed(hostings.flatMap((row) => row.hostnames))
        )
      )
    )
  if (doorways.length === 0) return new Map()
  const tunnels = new Map(doorways.map((d) => [d.tunnelId, d.tunnelOptions]))
  const states = await Promise.all(
    [...tunnels].map(async ([id, options]) => ({
      id,
      state: await tunnelVerifyState(db, { id, options }, now),
    }))
  )
  const verified = new Set(states.filter((s) => s.state.active).map((s) => s.id))
  return matchHostingTunnelPaths(hostings, doorways, verified)
}
