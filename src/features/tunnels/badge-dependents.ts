/**
 * What stops working when an API Token (or one zone of it) goes away. The last
 * token that reaches tunnels strands every tunnel of the account; the last one
 * that reaches DNS for a zone can no longer remove the DNS names of hostnames
 * in that zone. Certificates and certificate orders that a token alone can
 * revoke or renew are added here by the certificate features.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { doorway, tunnel } from '../../db/schema.ts'
import { compareText } from './order.ts'
import { listBadges, type BadgeRow } from './records.ts'
import type { BadgeCapabilities } from './vocabulary.ts'

export type BadgeDependent = {
  kind: 'tunnel' | 'hostname'
  id: string
  name: string
  /** The zone for a hostname, else null. */
  zone: string | null
}

/** Most dependents listed in a refusal; the rest are only counted. */
const MAX_LISTED = 50

/** What a token reaches that no other active token of the account does. */
export type BadgeLoss = { tunnels: boolean; dnsZones: { id: string; name: string }[] }

function capsOf(row: Pick<BadgeRow, 'capabilities'>): BadgeCapabilities {
  const c = (row.capabilities ?? {}) as Partial<BadgeCapabilities>
  return {
    tunnels: c.tunnels === true,
    dns: Array.isArray(c.dns) ? c.dns : [],
    certificates: Array.isArray(c.certificates) ? c.certificates : [],
  }
}

/** What would be left with no cover if `caps` stopped counting for `without`. */
export function lossOf(caps: BadgeCapabilities, others: readonly BadgeRow[]): BadgeLoss {
  const active = others.filter((b) => b.status === 'active').map(capsOf)
  return {
    tunnels: caps.tunnels && !active.some((c) => c.tunnels),
    dnsZones: caps.dns.filter((z) => !active.some((c) => c.dns.some((d) => d.id === z.id))),
  }
}

/** The tunnels and hostnames that depend on what would be lost. */
export async function dependentsOf(
  db: Db,
  carrierId: string,
  loss: BadgeLoss
): Promise<{ dependents: BadgeDependent[]; total: number }> {
  const found: BadgeDependent[] = []
  if (loss.tunnels) {
    const tunnels = await db
      .select({ id: tunnel.id, name: tunnel.name })
      .from(tunnel)
      .where(eq(tunnel.carrierId, carrierId))
      .orderBy(asc(tunnel.name))
    found.push(
      ...tunnels.map((t) => ({ kind: 'tunnel' as const, id: t.id, name: t.name, zone: null }))
    )
  }
  if (loss.dnsZones.length > 0) {
    const ids = loss.dnsZones.map((z) => z.id)
    const names = new Map(loss.dnsZones.map((z) => [z.id, z.name]))
    const hostnames = await db
      .select({
        id: doorway.id,
        hostname: doorway.hostname,
        zoneId: sql<string>`${doorway.metadata} ->> 'zoneId'`,
      })
      .from(doorway)
      .innerJoin(tunnel, eq(tunnel.id, doorway.tunnelId))
      .where(
        and(
          eq(tunnel.carrierId, carrierId),
          isNotNull(doorway.externalDnsRecordId),
          inArray(sql`${doorway.metadata} ->> 'zoneId'`, ids)
        )
      )
    found.push(
      ...hostnames
        .sort((a, b) => compareText(a.hostname, b.hostname))
        .map((h) => ({
          kind: 'hostname' as const,
          id: h.id,
          name: h.hostname,
          zone: names.get(h.zoneId) ?? null,
        }))
    )
  }
  return { dependents: found.slice(0, MAX_LISTED), total: found.length }
}

/** Convenience: the loss of removing one whole badge from its carrier. */
export async function lossOfRemoving(db: Db, row: BadgeRow): Promise<BadgeLoss> {
  const others = (await listBadges(db, row.carrierId)).filter((b) => b.id !== row.id)
  return lossOf(capsOf(row), others)
}
