/**
 * A server's container range (`server.container_prefix`): the /16 its
 * cross-server container networks are carved from. It belongs to the server,
 * not to TurboFabric, so two servers on a shared trusted LAN can run a
 * cross-server network with TurboFabric off. A relay's `prefix` mirrors it.
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { fabric, organization, relay, server } from '../../db/schema.ts'
import { loadCidrAllocationExclusions } from '../net/cidr-collisions.ts'
import { FabricAllocationError } from './allocation-error.ts'
import {
  DEFAULT_FABRIC_CONTAINER_POOL,
  nextFreeSubnet,
  parseFabricOptions,
  RELAY_PREFIX_LENGTH,
} from './cidr.ts'

/**
 * Lowest free relay `/16` in the container pool. `occupied` is the exact set
 * of prefixes other relays already hold; `exclusions` are org ranges the
 * prefix must not overlap (reserved rows, site subnets — see
 * `loadCidrAllocationExclusions`). Exhaustion, including exhaustion caused
 * purely by exclusions, still raises `fabric_prefix_pool_exhausted`.
 */
export function requireRelayPrefix(
  containerPool: string,
  occupied: readonly string[],
  exclusions: readonly string[] = []
): string {
  const prefix = nextFreeSubnet(containerPool, RELAY_PREFIX_LENGTH, occupied, exclusions)
  if (!prefix) {
    throw new FabricAllocationError('fabric_prefix_pool_exhausted')
  }
  return prefix
}

function cidrText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The org container pool: the fabric's when there is a fabric row, else the default. */
async function organizationContainerPool(db: Db, organizationId: string): Promise<string> {
  const [row] = await db
    .select({ options: fabric.options })
    .from(fabric)
    .where(eq(fabric.organizationId, organizationId))
    .limit(1)
  return row ? parseFabricOptions(row.options).containerPool : DEFAULT_FABRIC_CONTAINER_POOL
}

/** Every container range already held in the organization (servers and relays). */
async function occupiedContainerPrefixes(db: Db, organizationId: string): Promise<string[]> {
  const [servers, relays] = await Promise.all([
    db
      .select({ prefix: server.containerPrefix })
      .from(server)
      .where(and(eq(server.organizationId, organizationId), isNotNull(server.containerPrefix))),
    db
      .select({ prefix: relay.prefix })
      .from(relay)
      .innerJoin(fabric, eq(fabric.id, relay.fabricId))
      .where(eq(fabric.organizationId, organizationId)),
  ])
  const out = new Set<string>()
  for (const row of [...servers, ...relays]) {
    const prefix = cidrText(row.prefix)
    if (prefix) out.add(prefix)
  }
  return [...out]
}

async function storedPrefix(db: Db, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ prefix: server.containerPrefix })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return cidrText(row?.prefix)
}

/** A relay row's prefix for this server, kept when the server has none yet. */
async function relayPrefix(db: Db, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ prefix: relay.prefix })
    .from(relay)
    .where(eq(relay.serverId, serverId))
    .limit(1)
  return cidrText(row?.prefix)
}

/**
 * The server's container range, allocated on first need from the org pool
 * (`fabric.options.containerPool` when a fabric row exists, else the default)
 * outside every server and relay range and every org range. The org row is
 * locked while allocating so two servers never get the same range.
 * `exclusions` replaces the default org ranges (the fabric adds gateway LAN
 * ranges to them).
 */
export async function ensureServerContainerPrefix(
  db: Db,
  params: { organizationId: string; serverId: string; exclusions?: readonly string[] }
): Promise<string> {
  const existing = await storedPrefix(db, params.serverId)
  if (existing) return existing
  return db.transaction(async (tx) => {
    await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, params.organizationId))
      .for('update')
    const raced = await storedPrefix(tx, params.serverId)
    if (raced) return raced
    let prefix = await relayPrefix(tx, params.serverId)
    if (!prefix) {
      const [pool, occupied, exclusions] = await Promise.all([
        organizationContainerPool(tx, params.organizationId),
        occupiedContainerPrefixes(tx, params.organizationId),
        params.exclusions ?? loadCidrAllocationExclusions(tx, params.organizationId),
      ])
      prefix = requireRelayPrefix(pool, occupied, exclusions)
    }
    await tx.update(server).set({ containerPrefix: prefix }).where(eq(server.id, params.serverId))
    return prefix
  })
}

/** Stored container ranges by server (servers without one are left out). */
export async function loadServerContainerPrefixes(
  db: Db,
  organizationId: string
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: server.id, prefix: server.containerPrefix })
    .from(server)
    .where(and(eq(server.organizationId, organizationId), isNotNull(server.containerPrefix)))
  const out = new Map<string, string>()
  for (const row of rows) {
    const prefix = cidrText(row.prefix)
    if (prefix) out.set(row.id, prefix)
  }
  return out
}
