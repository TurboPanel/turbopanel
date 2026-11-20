/**
 * Which tunnel names the connector may verify. Verification is per name: the
 * route of a name sets `noTLSVerify: false` only when all of these hold, and
 * every other name keeps skipping verification so one site that is not ready
 * never makes its neighbours unreachable.
 *
 * 1. The name's pin is a provider origin certificate, or a ready public Let's
 *    Encrypt pair (a name with no pin, or one pinned to anything else, is not).
 * 2. The certificate covers the name.
 * 3. A successful deploy carried it: every deployment of the site's
 *    environment is `applied`, and each one was queued after the pin (and the
 *    certificate) last changed, so the server really holds that pair.
 *
 * `nameIsVerified` is the pure rule; `loadVerifiedNames` reads the facts.
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  command,
  deployment,
  doorway,
  hostname,
  hosting,
  service,
  tls,
  tunnel,
} from '../../db/schema.ts'
import { compareText } from './order.ts'
import { coversHostname } from '../../lib/tls/match.ts'
import {
  certificateCoversAll,
  originCertificateIsDue,
  readProviderOrigin,
} from './origin-certificate.ts'

export type PinFacts = {
  source: string
  status: string
  notAfter: string | null
  hasPair: boolean
  /** Residual metadata (`dnsNames`, `providerOrigin`). */
  metadata: unknown
  updatedAt: string
}

export type DeploymentFacts = {
  status: string
  /** When the payload of the last apply was queued, or an estimate of it. */
  queuedAt: string | null
}

export type NameFacts = {
  hostname: string
  pin: PinFacts | null
  /** When the name's pin last changed. */
  pinnedAt: string
  deployments: readonly DeploymentFacts[]
}

function dnsNamesOf(metadata: unknown): string[] {
  const names = (metadata as { dnsNames?: unknown } | null)?.dnsNames
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

function acmeOf(metadata: unknown): { staging?: unknown; managedBy?: unknown } | null {
  const acme = (metadata as { acme?: unknown } | null)?.acme
  return typeof acme === 'object' && acme !== null ? acme : null
}

/** A pair from the authority's test directory: no browser trusts it, so the connector must not either. */
function isStagingPair(metadata: unknown): boolean {
  return acmeOf(metadata)?.staging === true
}

/** A library pair this panel ordered itself over DNS (a public Let's Encrypt certificate too). */
function isPanelOrderedLibraryPair(pin: PinFacts): boolean {
  return pin.source === 'upload' && acmeOf(pin.metadata)?.managedBy === 'panel'
}

function pinCoversAndIsPublic(pin: PinFacts, name: string, now: Date): boolean {
  if (pin.source === 'provider_origin') {
    const link = readProviderOrigin(pin.metadata)
    return (
      pin.status === 'ready' &&
      pin.hasPair &&
      link !== null &&
      !originCertificateIsDue(pin.notAfter, now) &&
      certificateCoversAll(link, [name])
    )
  }
  if (pin.source === 'lets_encrypt' || isPanelOrderedLibraryPair(pin)) {
    const expires = pin.notAfter ? Date.parse(pin.notAfter) : Number.NaN
    return (
      pin.status === 'ready' &&
      pin.hasPair &&
      !isStagingPair(pin.metadata) &&
      !Number.isNaN(expires) &&
      expires > now.getTime() &&
      coversHostname(dnsNamesOf(pin.metadata), name)
    )
  }
  return false
}

function carried(facts: NameFacts): boolean {
  if (!facts.pin || facts.deployments.length === 0) return false
  const since = Math.max(Date.parse(facts.pinnedAt), Date.parse(facts.pin.updatedAt))
  return facts.deployments.every((d) => {
    const queued = d.queuedAt ? Date.parse(d.queuedAt) : Number.NaN
    return d.status === 'applied' && !Number.isNaN(queued) && queued >= since
  })
}

export function nameIsVerified(facts: NameFacts, now: Date = new Date()): boolean {
  return (
    facts.pin !== null && pinCoversAndIsPublic(facts.pin, facts.hostname, now) && carried(facts)
  )
}

type DoorwayName = { hostname: string; hostingId: string }

/** Read the facts of each name of a tunnel that is served by a site. */
async function loadNameFacts(db: Db, doorways: readonly DoorwayName[]): Promise<NameFacts[]> {
  const hostingIds = [...new Set(doorways.map((d) => d.hostingId))]
  if (hostingIds.length === 0) return []
  const [names, sites, runs] = await Promise.all([
    db
      .select({
        hostingId: hostname.hostingId,
        hostname: hostname.hostname,
        certificate: hostname.certificate,
        tlsId: hostname.tlsId,
        updatedAt: hostname.updatedAt,
      })
      .from(hostname)
      .where(inArray(hostname.hostingId, hostingIds)),
    db
      .select({ id: hosting.id, tlsId: hosting.tlsId, updatedAt: hosting.updatedAt })
      .from(hosting)
      .where(inArray(hosting.id, hostingIds)),
    db
      .select({
        hostingId: hosting.id,
        status: deployment.status,
        finishedAt: deployment.finishedAt,
        durationMs: deployment.durationMs,
        commandAt: command.createdAt,
      })
      .from(hosting)
      .innerJoin(service, eq(service.id, hosting.serviceId))
      .innerJoin(deployment, eq(deployment.environmentId, service.environmentId))
      .leftJoin(command, eq(command.id, deployment.lastCommandId))
      .where(inArray(hosting.id, hostingIds)),
  ])
  const siteOf = new Map(sites.map((s) => [s.id, s]))
  const nameRow = new Map(names.map((n) => [`${n.hostingId}\n${n.hostname.toLowerCase()}`, n]))
  const pinIds = new Set<string>()
  const chosen = doorways.flatMap((d) => {
    const row = nameRow.get(`${d.hostingId}\n${d.hostname.toLowerCase()}`)
    const site = siteOf.get(d.hostingId)
    // A name the site does not store is not served by it, so nothing was carried for it.
    if (!row || !site) return []
    // No stored choice reads as the whole-site pin.
    const own = row.certificate !== null
    const tlsId = own ? row.tlsId : site.tlsId
    if (tlsId) pinIds.add(tlsId)
    // The pin changed when the name's own row did, or, for the site's pin, when the site did.
    const pinnedAt =
      own || Date.parse(row.updatedAt) >= Date.parse(site.updatedAt)
        ? row.updatedAt
        : site.updatedAt
    return [{ d, tlsId, pinnedAt }]
  })
  const pins = pinIds.size
    ? await db
        .select({
          id: tls.id,
          source: tls.source,
          status: tls.status,
          notAfter: tls.notAfter,
          pem: tls.certificatePem,
          key: tls.privateKeyPem,
          metadata: tls.metadata,
          updatedAt: tls.updatedAt,
        })
        .from(tls)
        .where(inArray(tls.id, [...pinIds]))
    : []
  const pinOf = new Map(pins.map((p) => [p.id, p]))
  return chosen.map(({ d, tlsId, pinnedAt }) => {
    const pin = tlsId ? pinOf.get(tlsId) : undefined
    return {
      hostname: d.hostname,
      pin: pin
        ? {
            source: pin.source,
            status: pin.status,
            notAfter: pin.notAfter,
            hasPair: Boolean(pin.pem && pin.key),
            metadata: pin.metadata,
            updatedAt: pin.updatedAt,
          }
        : null,
      pinnedAt,
      deployments: runs
        .filter((r) => r.hostingId === d.hostingId)
        .map((r) => ({
          status: r.status,
          queuedAt:
            r.commandAt ??
            (r.finishedAt
              ? new Date(Date.parse(r.finishedAt) - (r.durationMs ?? 0)).toISOString()
              : null),
        })),
    }
  })
}

/** The names of one tunnel the connector may verify now, lower case, sorted. */
export async function loadVerifiedNames(
  db: Db,
  tunnelId: string,
  now: Date = new Date()
): Promise<string[]> {
  const rows = await db
    .select({ hostname: doorway.hostname, hostingId: doorway.hostingId })
    .from(doorway)
    .where(and(eq(doorway.tunnelId, tunnelId), ne(doorway.status, 'removing')))
  const served = rows.flatMap((r) =>
    r.hostingId ? [{ hostname: r.hostname, hostingId: r.hostingId }] : []
  )
  const facts = await loadNameFacts(db, served)
  return facts
    .filter((f) => nameIsVerified(f, now))
    .map((f) => f.hostname)
    .toSorted(compareText)
}

/** Hostnames of every tunnel of the organization (any name an origin certificate may be kept for). */
export async function tunnelDoorwayHostnames(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ hostname: doorway.hostname })
    .from(doorway)
    .innerJoin(tunnel, eq(tunnel.id, doorway.tunnelId))
    .where(and(eq(tunnel.organizationId, organizationId), ne(doorway.status, 'removing')))
  return rows.map((r) => r.hostname)
}
