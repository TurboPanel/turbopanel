/**
 * Turning the verified connection on or off for one tunnel. On: every site that
 * serves the tunnel's names gets an origin certificate for exactly the names it
 * serves (an existing TurboPanel certificate that already covers them is reused;
 * a wildcard only when the person chose one), the site is pointed at it, and the
 * connector is told to verify. A site that does not exist yet has nothing to
 * point at, so its names stay `pending` and the connector keeps skipping
 * verification for the whole tunnel until the option is applied again. Off: the
 * connector skips verification again; the sites keep their certificate.
 */
import { eq } from 'drizzle-orm'
import { hostingCertificateNames } from '../../contracts/commands/hostname.ts'
import type { Db } from '../../db/connection.ts'
import { hostname, hosting, tunnel } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { readHostingWwwMode } from '../hostings/hosting-options.ts'
import type { TunnelAdapter } from './adapter.ts'
import {
  type TunnelRow,
  listDoorways,
  openCarrierToken,
  providerRefusal,
  routeNames,
  TunnelRefusal,
} from './lifecycle.ts'
import {
  certificateCoversAll,
  ensureOriginCertificate,
  type OriginCertificateScope,
  readProviderOrigin,
  retireUnusedOriginCertificates,
} from './origin-certificate.ts'
import type { BadgeRow, CarrierRow } from './records.ts'
import { type VerifyState, tunnelVerifyState, verifyOriginHostnames } from './verify-state.ts'

export type VerifyOriginDeps = {
  db: Db
  secrets: DerivedSecretsConfig
  adapter: TunnelAdapter
  organizationId: string
  /** The API token (badge) of the carrier that can manage certificates for the zone, or null. */
  chooseBadge(zoneName: string): Promise<BadgeRow | null>
}

export type VerifyOriginResult = {
  state: VerifyState
  /** Sites now pointed at an origin certificate. Their servers pick it up on the next deploy. */
  pinnedHostingIds: string[]
  /** Certificates that were reused instead of issued. */
  reusedCertificateIds: string[]
  /** Certificates issued now. */
  issuedCertificateIds: string[]
}

async function hostingNames(db: Db, hostingId: string): Promise<string[]> {
  const [site] = await db
    .select({ options: hosting.options })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  const rows = await db
    .select({ hostname: hostname.hostname })
    .from(hostname)
    .where(eq(hostname.hostingId, hostingId))
  return hostingCertificateNames({
    hostnames: rows.map((r) => r.hostname),
    www: readHostingWwwMode(site?.options),
  })
}

/** The zone a set of names lives in; they must all share one (a site pins one certificate). */
async function singleZone(
  adapter: TunnelAdapter,
  token: string,
  accountId: string | null,
  names: readonly string[]
): Promise<{ id: string; name: string }> {
  const zones = await Promise.all(
    names.map((n) => adapter.findZone(token, { accountId, hostname: n }))
  )
  const first = zones[0]!
  if (zones.some((z) => z.id !== first.id)) {
    throw new TunnelRefusal(
      'verify_origin_zones',
      409,
      'This site serves names in more than one zone, and a site can use only one certificate'
    )
  }
  return first
}

/**
 * Give one site the origin certificate for the names it serves and point it at
 * it. Refused when the site also serves a name that is not a tunnel name that
 * asks for verification: browsers do not trust an origin certificate, so
 * pointing a public name at one would break it.
 */
async function certifyHosting(
  deps: VerifyOriginDeps,
  owner: CarrierRow,
  hostingId: string,
  tunnelNames: ReadonlySet<string>,
  scope: OriginCertificateScope
): Promise<{ tlsId: string; reused: boolean; changed: boolean }> {
  const names = await hostingNames(deps.db, hostingId)
  const outside = names.filter((n) => !tunnelNames.has(n))
  if (outside.length > 0) {
    throw new TunnelRefusal(
      'verify_origin_public_names',
      409,
      `This site also serves ${outside.join(', ')}, which is not a Tunnel name with a verified connection, so an origin certificate would break it`
    )
  }
  const dnsToken = await openCarrierToken(deps.db, deps.secrets, owner.id, { anyDns: true })
  if (!dnsToken) {
    throw new TunnelRefusal(
      'badge_cannot_dns',
      409,
      'No API Token on this Carrier can read DNS zones'
    )
  }
  const zone = await singleZone(deps.adapter, dnsToken, owner.externalAccountId, names)
  const badge = await deps.chooseBadge(zone.name)
  if (badge === null) {
    throw new TunnelRefusal(
      'badge_cannot_certify',
      409,
      'No API Token on this Carrier can manage certificates for that zone'
    )
  }
  const ensured = await ensureOriginCertificate({
    db: deps.db,
    secrets: deps.secrets,
    adapter: deps.adapter,
    organizationId: deps.organizationId,
    carrier: owner,
    badge,
    zoneName: zone.name,
    names,
    scope,
  })
  const link = readProviderOrigin(ensured.row.metadata)
  if (!link || !certificateCoversAll(link, names)) {
    throw new TunnelRefusal(
      'verify_origin_names',
      409,
      'A wildcard certificate covers one label below the zone; this site serves a deeper name. Use certificates for hostnames instead'
    )
  }
  const [current] = await deps.db
    .select({ tlsId: hosting.tlsId })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  const changed = current?.tlsId !== ensured.row.id
  if (changed)
    await deps.db.update(hosting).set({ tlsId: ensured.row.id }).where(eq(hosting.id, hostingId))
  return { tlsId: ensured.row.id, reused: ensured.reused, changed }
}

async function saveOption(db: Db, row: TunnelRow, enabled: boolean): Promise<TunnelRow> {
  const base = (row.options && typeof row.options === 'object' ? row.options : {}) as Record<
    string,
    unknown
  >
  const [updated] = await db
    .update(tunnel)
    .set({ options: { ...base, verifyOrigin: enabled } })
    .where(eq(tunnel.id, row.id))
    .returning()
  return updated!
}

async function pushRoutes(
  deps: VerifyOriginDeps,
  owner: CarrierRow,
  row: TunnelRow,
  token: string
): Promise<VerifyState> {
  const state = await tunnelVerifyState(deps.db, row)
  if (!row.externalId) return state
  try {
    await deps.adapter.setRoutes(token, {
      accountId: owner.externalAccountId,
      externalId: row.externalId,
      hostnames: await routeNames(deps.db, row.id, null),
      verifyOrigin: state.active,
    })
  } catch (err) {
    throw providerRefusal(err)
  }
  return state
}

/**
 * Apply the choice. Safe to repeat: run it again when a site that was missing
 * has been created, or after names were added. Fails as a whole before the
 * option is saved, so a refusal leaves the tunnel as it was (certificates
 * already issued stay and are reused by the next try).
 */
export async function setVerifyOrigin(
  deps: VerifyOriginDeps,
  owner: CarrierRow,
  row: TunnelRow,
  enabled: boolean,
  scope: OriginCertificateScope = 'names'
): Promise<VerifyOriginResult & { tunnel: TunnelRow }> {
  const token = await openCarrierToken(deps.db, deps.secrets, owner.id, { tunnels: true })
  if (!token) {
    throw new TunnelRefusal(
      'badge_cannot_tunnel',
      409,
      'No API Token on this Carrier can edit Tunnels'
    )
  }
  const result: VerifyOriginResult = {
    state: { enabled, active: false, pendingNames: [] },
    pinnedHostingIds: [],
    reusedCertificateIds: [],
    issuedCertificateIds: [],
  }
  if (enabled) {
    const doorways = (await listDoorways(deps.db, row.id)).filter((d) => d.status !== 'removing')
    const tunnelNames = new Set([
      ...(await verifyOriginHostnames(deps.db, deps.organizationId)),
      ...doorways.map((d) => d.hostname),
    ])
    const hostingIds = [...new Set(doorways.flatMap((d) => (d.hostingId ? [d.hostingId] : [])))]
    for (const hostingId of hostingIds) {
      const done = await certifyHosting(deps, owner, hostingId, tunnelNames, scope)
      ;(done.reused ? result.reusedCertificateIds : result.issuedCertificateIds).push(done.tlsId)
      if (done.changed) result.pinnedHostingIds.push(hostingId)
    }
  }
  const saved = await saveOption(deps.db, row, enabled)
  result.state = await pushRoutes(deps, owner, saved, token)
  if (!enabled) {
    await retireUnusedOriginCertificates(
      deps.db,
      deps.organizationId,
      await verifyOriginHostnames(deps.db, deps.organizationId)
    )
  }
  return { ...result, tunnel: saved }
}
