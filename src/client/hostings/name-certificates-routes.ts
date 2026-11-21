/**
 * The per-name certificate choice on the hosting API: parsing `names` on
 * create and patch, and the `names` / `certificateOptions` a hosting is read
 * with. The storage rules are in `features/hostings/name-certificates.ts`; the
 * defaults table is in `features/hostings/name-certificate-options.ts`.
 */

import { and, eq, inArray, ne, or } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { doorway, tls } from '../../db/schema.ts'
import { coversHostname, normalizeHostname } from '../../lib/tls/match.ts'
import {
  type HostingWwwMode,
  hostingCertificateNames,
  wwwSiblingHostname,
} from '../../contracts/commands/hostname.ts'
import {
  parseHostingOptions,
  resolveHostingBind,
  resolveHostingProtocol,
} from '../../features/hostings/hosting-options.ts'
import {
  type NameCertificateOptions,
  type NameReach,
  type CoveringCertificate,
  nameCertificateOptions,
} from '../../features/hostings/name-certificate-options.ts'
import {
  type NameCertificate,
  certificateForPinSource,
  loadNameCertificates,
} from '../../features/hostings/name-certificates.ts'
import {
  type HostnameCertificate,
  isHostnameCertificate,
} from '../../features/hostings/name-certificate-vocabulary.ts'
import type { HostnameChoice } from '../../features/servers/hostname-records.ts'
import { loadDnsIssuance } from '../../features/hostings/dns-issuance.ts'
import { loadAcmeEnabled } from './letsencrypt-store.ts'
import { parseOptionalTlsId } from './routes-helpers.ts'

/** The most names one request may carry a choice for. */
const MAX_NAME_CHOICES = 200

export type NameChoicesResult =
  | { kind: 'absent' }
  | { kind: 'value'; choices: Map<string, HostnameChoice> }
  | { kind: 'error'; response: Response }

function invalidNames(c: Context, message: string): NameChoicesResult {
  return {
    kind: 'error',
    response: c.json({ error: 'invalid_name_certificates', message }, 400),
  }
}

function compareHostnames(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** One `names` entry: the normalized name and its choice, or the response that refuses it. */
async function parseNameChoiceEntry(
  c: Context,
  db: Db,
  organizationId: string,
  item: unknown,
  seen: ReadonlyMap<string, HostnameChoice>
): Promise<{ name: string; choice: HostnameChoice } | { response: NameChoicesResult }> {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return { response: invalidNames(c, 'each name choice must be an object') }
  }
  const entry = item as Record<string, unknown>
  if (typeof entry.hostname !== 'string' || entry.hostname.trim() === '') {
    return { response: invalidNames(c, 'each name choice needs a hostname') }
  }
  if (!isHostnameCertificate(entry.certificate)) {
    return { response: invalidNames(c, `${entry.hostname}: unknown certificate choice`) }
  }
  const name = normalizeHostname(entry.hostname)
  if (seen.has(name)) return { response: invalidNames(c, `${name} is listed twice`) }
  const pin = await parseOptionalTlsId(c, db, organizationId, entry.tlsId)
  if (pin.kind === 'error') return { response: pin }
  const tlsId = pin.kind === 'value' ? pin.value : null
  const problem =
    pinProblem(entry.certificate, tlsId) ??
    (await sourceProblem(db, entry.certificate, tlsId, name))
  if (problem !== null) return { response: invalidNames(c, `${name}: ${problem}`) }
  return { name, choice: { certificate: entry.certificate, tlsId } }
}

/**
 * Read `names: [{ hostname, certificate, tlsId? }]` from a request body.
 * `self_signed` carries no pin; the others may carry one (a pair that is still
 * being issued has none yet). A pin must be an organization certificate that
 * is not a test certificate.
 */
export async function parseNameChoices(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>
): Promise<NameChoicesResult> {
  const raw = body.names
  if (raw === undefined) return { kind: 'absent' }
  if (!Array.isArray(raw) || raw.length > MAX_NAME_CHOICES) {
    return invalidNames(c, 'names must be a list of name choices')
  }
  const choices = new Map<string, HostnameChoice>()
  for (const item of raw as unknown[]) {
    const parsed = await parseNameChoiceEntry(c, db, organizationId, item, choices)
    if ('response' in parsed) return parsed.response
    choices.set(parsed.name, parsed.choice)
  }
  return { kind: 'value', choices }
}

function pinProblem(certificate: HostnameCertificate, tlsId: string | null): string | null {
  if (certificate === 'self_signed' && tlsId !== null) {
    return 'a self-signed name has no certificate to pin'
  }
  if (certificate === 'library' && tlsId === null) return 'pick a certificate from the library'
  return null
}

/** The names a Let's Encrypt row covers (empty when it lists none). */
function coveredNames(metadata: unknown): string[] {
  const covered = (metadata as { dnsNames?: unknown } | null)?.dnsNames
  return Array.isArray(covered) ? covered.filter((n): n is string => typeof n === 'string') : []
}

/** A pinned certificate must be of the kind the choice names (an origin pair for the origin choice, and so on). */
async function sourceProblem(
  db: Db,
  certificate: HostnameCertificate,
  tlsId: string | null,
  name: string
): Promise<string | null> {
  if (tlsId === null) return null
  const [row] = await db
    .select({ source: tls.source, status: tls.status, metadata: tls.metadata })
    .from(tls)
    .where(eq(tls.id, tlsId))
    .limit(1)
  const expected = certificateForPinSource(row?.source)
  if (certificate === expected) return null
  // A Let's Encrypt row is picked as a library certificate or as the DNS choice's pair: it must
  // be one the library lists (ready or automatic) and must cover the name.
  const pickedLetsEncrypt =
    row?.source === 'lets_encrypt' &&
    (certificate === 'library' || certificate === 'letsencrypt_dns')
  if (pickedLetsEncrypt) {
    if (row.status !== 'ready' && row.status !== 'automatic') {
      return 'that certificate is not ready to use'
    }
    if (coversHostname(coveredNames(row.metadata), name)) return null
    return `that certificate does not cover ${name}`
  }
  return `that certificate cannot be used for ${certificate}`
}

/** The choices that name something this hosting does not serve, or null when all are served. */
export function unservedChoice(
  c: Context,
  choices: ReadonlyMap<string, HostnameChoice>,
  hostnames: readonly string[],
  www: HostingWwwMode
): Response | null {
  const served = new Set(hostingCertificateNames({ hostnames, www }))
  for (const name of choices.keys()) {
    if (!served.has(name)) {
      return c.json(
        {
          error: 'name_not_served',
          message: `${name} is not one of this site's names`,
        },
        400
      )
    }
  }
  return null
}

/**
 * Refuse a request that picks Let's Encrypt via DNS for a name the gate does
 * not offer it for (the same gate the choice list reads), so a client cannot
 * pick what the list shows as disabled. A name already stored with that choice
 * on this site is left alone, and so is a choice that pins an existing
 * certificate (nothing is ordered). `hostingId` is null on create.
 */
export async function refuseUnavailableDnsChoices(
  c: Context,
  db: Db,
  organizationId: string,
  site: { serviceId: string; hostingId: string | null },
  choices: ReadonlyMap<string, HostnameChoice>
): Promise<Response | null> {
  const picked = [...choices].filter(
    ([, choice]) => choice.certificate === 'letsencrypt_dns' && choice.tlsId === null
  )
  if (picked.length === 0) return null
  const stored =
    site.hostingId === null
      ? []
      : ((await loadNameCertificates(db, [site.hostingId])).get(site.hostingId) ?? [])
  const already = new Set(
    stored.filter((row) => row.certificate === 'letsencrypt_dns').map((row) => row.hostname)
  )
  const asked = picked.filter(([name]) => !already.has(name))
  if (asked.length === 0) return null
  const gate = await loadDnsIssuance(db, organizationId, [site.serviceId])
  for (const [name] of asked) {
    const facts = gate(site.serviceId, name)
    if (!facts.dnsIssuance) {
      return c.json(
        {
          error: 'dns_issuance_unavailable',
          message: `${name}: ${facts.dnsUnavailableReason ?? 'ordering over DNS is not available'}`,
        },
        409
      )
    }
  }
  return null
}

/** One served name as the hosting read shows it. */
export type HostingNameRead = NameCertificate & {
  certificateOptions: NameCertificateOptions
}

type HostingForNames = { id: string; serviceId: string; options: unknown }

type DoorwayReach = Map<string, boolean>

/** hostingId -> (lower-case name -> isLocalOnly) for the live doorways of these hostings. */
async function loadReach(
  db: Db,
  organizationId: string,
  hostingIds: readonly string[]
): Promise<Map<string, DoorwayReach>> {
  const out = new Map<string, DoorwayReach>()
  if (hostingIds.length === 0) return out
  const rows = await db
    .select({
      hostingId: doorway.hostingId,
      hostname: doorway.hostname,
      isLocalOnly: doorway.isLocalOnly,
    })
    .from(doorway)
    .where(
      and(
        eq(doorway.routingOrganizationId, organizationId),
        ne(doorway.status, 'removing'),
        inArray(doorway.hostingId, [...hostingIds])
      )
    )
  for (const row of rows) {
    if (row.hostingId === null) continue
    const names = out.get(row.hostingId) ?? new Map<string, boolean>()
    names.set(normalizeHostname(row.hostname), row.isLocalOnly)
    out.set(row.hostingId, names)
  }
  return out
}

type LibraryRow = { id: string; label: string; dnsNames: string[] }

/** Library certificates a person can pick for a name: ready or automatic, not a test certificate, not an origin certificate. */
async function loadLibraryRows(db: Db, organizationId: string): Promise<LibraryRow[]> {
  const rows = await db
    .select({ id: tls.id, name: tls.name, metadata: tls.metadata })
    .from(tls)
    .where(
      and(
        eq(tls.organizationId, organizationId),
        or(eq(tls.status, 'ready'), eq(tls.status, 'automatic')),
        ne(tls.source, 'provider_origin')
      )
    )
  const out: LibraryRow[] = []
  for (const row of rows) {
    const metadata = row.metadata as { dnsNames?: unknown; acme?: { staging?: unknown } } | null
    if (metadata?.acme?.staging === true) continue
    const names = Array.isArray(metadata?.dnsNames)
      ? (metadata.dnsNames as unknown[]).filter((n): n is string => typeof n === 'string')
      : []
    if (names.length === 0) continue
    out.push({ id: row.id, label: row.name ?? names[0]!, dnsNames: names })
  }
  return out
}

function reachOf(isLocalOnly: boolean | undefined): NameReach {
  if (isLocalOnly === undefined) return 'direct'
  return isLocalOnly ? 'tunnel' : 'tunnel_and_direct'
}

/**
 * The per-name read for these hostings: each served name with its stored
 * choice and the options with their defaults. Keyed by hosting id; a hosting
 * with no `hostname` rows maps to an empty list.
 */
export async function loadHostingNameReads(
  db: Db,
  organizationId: string,
  hostings: readonly HostingForNames[]
): Promise<Map<string, HostingNameRead[]>> {
  const ids = hostings.map((h) => h.id)
  const [stored, reach, library, acmeEnabled, dnsGate] = await Promise.all([
    loadNameCertificates(db, ids),
    loadReach(db, organizationId, ids),
    loadLibraryRows(db, organizationId),
    loadAcmeEnabled(db, organizationId),
    loadDnsIssuance(
      db,
      organizationId,
      hostings.map((h) => h.serviceId)
    ),
  ])
  const out = new Map<string, HostingNameRead[]>()
  for (const row of hostings) {
    const options = parseHostingOptions(row.options)
    const bind = resolveHostingBind(options)
    const isHttp = resolveHostingProtocol(options) === 'http'
    const doorwayReach = reach.get(row.id)
    const names = [...(stored.get(row.id) ?? [])].toSorted((a, b) =>
      compareHostnames(a.hostname, b.hostname)
    )
    out.set(
      row.id,
      names.map((name) => {
        const covering: CoveringCertificate[] = library
          .filter((cert) => coversHostname(cert.dnsNames, name.hostname))
          .map((cert) => ({ id: cert.id, label: cert.label }))
        // A www partner that is not typed rides with the name it is the partner of.
        const sibling = wwwSiblingHostname(name.hostname)
        const own =
          doorwayReach?.get(name.hostname) ??
          (sibling === null ? undefined : doorwayReach?.get(sibling))
        return {
          ...name,
          certificateOptions: nameCertificateOptions({
            hostname: name.hostname,
            reach: reachOf(own),
            bind,
            isHttp,
            acmeEnabled,
            ...dnsGate(row.serviceId, name.hostname),
            covering,
          }),
        }
      })
    )
  }
  return out
}
