/**
 * SQL conditions for reading `relay` rows the way the mesh sees them. Kept
 * apart from `fabric-records.ts` so the address ladder, firewall and login
 * readers can use them without importing the fabric planner.
 */
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { fabric, relay, server } from '../../db/schema.ts'

/**
 * The relay's server has TurboFabric switched on. A server switched off keeps
 * its relay row (address, prefix, endpoint pin, preshared key and LAN sharing
 * stay reserved for it) but is left out of every peer list, snapshot, ladder
 * and exposure. Address allocation reads every row.
 */
export function relayServerSwitchedOn(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${server} WHERE ${server.id} = ${relay.serverId} AND ${server.isFabricEnabled} = false)`
}

/** For a query joined to `fabric`: the mesh is on (not paused) and the relay's server is switched on. */
export function relayCarriesTraffic(): SQL {
  return and(eq(fabric.isEnabled, true), relayServerSwitchedOn()) as SQL
}
