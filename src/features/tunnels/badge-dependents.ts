/**
 * What stops working when an API Token (or one zone of it) goes away. Items
 * belong to the account, not to the token that made them, so only what no
 * other active token of the account covers counts: the last token that reaches
 * tunnels strands every tunnel of the account; the last one that reaches DNS
 * for a zone can no longer remove the DNS names of hostnames in that zone, nor
 * renew the Let's Encrypt certificates validated in it; the last one that
 * manages certificates for a zone can no longer renew or revoke its origin
 * certificates.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { doorway, tls, tunnel } from '../../db/schema.ts'
import { compareText } from './order.ts'
import { listBadges, type BadgeRow } from './records.ts'
import type { BadgeCapabilities } from './vocabulary.ts'

export type BadgeDependent = {
  kind: 'tunnel' | 'hostname' | 'certificate'
  id: string
  name: string
  /** The zone for a hostname or a certificate, else null. */
  zone: string | null
}

/** Most dependents listed in a refusal; the rest are only counted. */
const MAX_LISTED = 50

/** What a token reaches that no other active token of the account does. */
export type BadgeLoss = {
  tunnels: boolean
  dnsZones: { id: string; name: string }[]
  /** Zones whose origin certificates no other token could renew or revoke. */
  certificateZones: { id: string; name: string }[]
}

type Zone = { id: string; name: string }

/** The zones of `zones` that none of `covered` reaches, matched by id. */
function uncovered(zones: readonly Zone[], covered: readonly Zone[][]): Zone[] {
  return zones.filter((z) => !covered.some((list) => list.some((d) => d.id === z.id)))
}

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
    dnsZones: uncovered(
      caps.dns,
      active.map((c) => c.dns)
    ),
    certificateZones: uncovered(
      caps.certificates,
      active.map((c) => c.certificates)
    ),
  }
}

async function tunnelDependents(db: Db, carrierId: string): Promise<BadgeDependent[]> {
  const tunnels = await db
    .select({ id: tunnel.id, name: tunnel.name })
    .from(tunnel)
    .where(eq(tunnel.carrierId, carrierId))
    .orderBy(asc(tunnel.name))
  return tunnels.map((t) => ({ kind: 'tunnel' as const, id: t.id, name: t.name, zone: null }))
}

async function hostnameDependents(
  db: Db,
  carrierId: string,
  zones: readonly Zone[]
): Promise<BadgeDependent[]> {
  const names = new Map(zones.map((z) => [z.id, z.name]))
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
        inArray(sql`${doorway.metadata} ->> 'zoneId'`, [...names.keys()])
      )
    )
  return hostnames
    .sort((a, b) => compareText(a.hostname, b.hostname))
    .map((h) => ({
      kind: 'hostname' as const,
      id: h.id,
      name: h.hostname,
      zone: names.get(h.zoneId) ?? null,
    }))
}

/**
 * Certificates of the account that need a token for one of `zones`: origin
 * certificates (`providerOrigin`, renewed and revoked with a certificates
 * right) and Let's Encrypt certificates validated by DNS (`dnsCert`, renewed
 * with a DNS right). A retired origin certificate still counts: it is revoked later.
 */
async function certificateDependents(
  db: Db,
  carrierId: string,
  loss: Pick<BadgeLoss, 'dnsZones' | 'certificateZones'>
): Promise<BadgeDependent[]> {
  const originZones = new Map(loss.certificateZones.map((z) => [z.id, z.name]))
  const dnsZones = new Map(loss.dnsZones.map((z) => [z.id, z.name]))
  if (originZones.size === 0 && dnsZones.size === 0) return []
  const rows = await db
    .select({ id: tls.id, name: tls.name, metadata: tls.metadata })
    .from(tls)
    .where(
      sql`(${tls.metadata} #>> '{providerOrigin,carrierId}' = ${carrierId} or ${tls.metadata} #>> '{dnsCert,carrierId}' = ${carrierId})`
    )
  return rows
    .flatMap((row) => {
      const zone = certificateZone(row.metadata, carrierId, originZones, dnsZones)
      if (zone === null) return []
      return [{ kind: 'certificate' as const, id: row.id, name: certificateName(row), zone }]
    })
    .sort((a, b) => compareText(a.name, b.name))
}

/** The certificate's library name, else its first hostname. */
function certificateName(row: { id: string; name: string | null; metadata: unknown }): string {
  if (row.name) return row.name
  const hostnames = (row.metadata as { providerOrigin?: { hostnames?: unknown } } | null)
    ?.providerOrigin?.hostnames
  return Array.isArray(hostnames) && typeof hostnames[0] === 'string' ? hostnames[0] : row.id
}

/** The lost zone a certificate row needs, or null when it needs none of them. */
function certificateZone(
  metadata: unknown,
  carrierId: string,
  originZones: ReadonlyMap<string, string>,
  dnsZones: ReadonlyMap<string, string>
): string | null {
  const m = (metadata ?? {}) as {
    providerOrigin?: { carrierId?: unknown; zoneId?: unknown }
    dnsCert?: { carrierId?: unknown; zones?: unknown }
  }
  const origin = m.providerOrigin
  if (origin?.carrierId === carrierId && typeof origin.zoneId === 'string') {
    const name = originZones.get(origin.zoneId)
    if (name !== undefined) return name
  }
  const dns = m.dnsCert
  if (dns?.carrierId !== carrierId || !Array.isArray(dns.zones)) return null
  for (const z of dns.zones as { id?: unknown }[]) {
    const name = typeof z?.id === 'string' ? dnsZones.get(z.id) : undefined
    if (name !== undefined) return name
  }
  return null
}

/** The tunnels, hostnames and certificates that depend on what would be lost. */
export async function dependentsOf(
  db: Db,
  carrierId: string,
  loss: BadgeLoss
): Promise<{ dependents: BadgeDependent[]; total: number }> {
  const found: BadgeDependent[] = [
    ...(loss.tunnels ? await tunnelDependents(db, carrierId) : []),
    ...(loss.dnsZones.length > 0 ? await hostnameDependents(db, carrierId, loss.dnsZones) : []),
    ...(await certificateDependents(db, carrierId, loss)),
  ]
  return { dependents: found.slice(0, MAX_LISTED), total: found.length }
}

/**
 * One plain sentence naming what still needs the token, for a refusal:
 * "Still needed by the tunnel web and the certificate app.example.com (example.com). ..."
 */
export function dependentsSentence(dependents: readonly BadgeDependent[], total: number): string {
  const listed = dependents.slice(0, 5).map((d) => {
    const zone = d.kind !== 'tunnel' && d.zone ? ` (${d.zone})` : ''
    return `the ${d.kind} ${d.name}${zone}`
  })
  const more = Math.max(total, dependents.length) - listed.length
  const items = more > 0 ? `${listed.join(', ')} and ${more} more` : joinAnd(listed)
  return `No other API Token on this account covers ${items}. Add a token that does, then remove this one.`
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** Convenience: the loss of removing one whole badge from its carrier. */
export async function lossOfRemoving(db: Db, row: BadgeRow): Promise<BadgeLoss> {
  // A token that is not active serves nothing, so removing it loses nothing.
  if (row.status !== 'active') return { tunnels: false, dnsZones: [], certificateZones: [] }
  const others = (await listBadges(db, row.carrierId)).filter((b) => b.id !== row.id)
  return lossOf(capsOf(row), others)
}
