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
  badgeRefusal,
  providerRefusal,
  refuse,
  routeNames,
  TunnelRefusal,
} from './lifecycle.ts'
import {
  certificateCoversAll,
  originCertificateNames,
  ensureOriginCertificate,
  type OriginCertificateScope,
  readProviderOrigin,
  retireUnusedOriginCertificates,
} from './origin-certificate.ts'
import { type CarrierRow, findStoredZone, listBadges, pickBadges } from './records.ts'
import { coversHostname } from '../../lib/tls/match.ts'
import { mapSequential } from '../../lib/sequential.ts'
import { BadgeUnavailable, openBestBadge, useBadges } from './badge-use.ts'
import { type VerifyState, tunnelVerifyState, verifyOriginHostnames } from './verify-state.ts'

export type VerifyOriginDeps = {
  db: Db
  secrets: DerivedSecretsConfig
  adapter: TunnelAdapter
  organizationId: string
}

export type VerifyOriginResult = {
  state: VerifyState
  /** Sites now pointed at an origin certificate. Their servers pick it up on the next deploy. */
  pinnedHostingIds: string[]
  /** Certificates that were reused instead of issued. */
  reusedCertificateIds: string[]
  /** Certificates issued now. */
  issuedCertificateIds: string[]
  /** Sites left for the next request: one request issues at most `MAX_CERTIFICATES_PER_VERIFY`. */
  deferredHostingIds: string[]
}

/** Most certificates one request asks the provider for; apply again to continue (it is idempotent). */
export const MAX_CERTIFICATES_PER_VERIFY = 10

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

/** The zone of one name: a zone an active token was found to reach first, else the provider is asked. */
async function zoneOf(
  deps: VerifyOriginDeps,
  owner: CarrierRow,
  name: string
): Promise<{ id: string; name: string }> {
  const stored = findStoredZone(await listBadges(deps.db, owner.id), name)
  if (stored) return stored
  const opened = await openBestBadge(deps.db, deps.secrets, owner.id, { capability: 'tunnels' })
  if (!opened) {
    throw badgeRefusal(
      new BadgeUnavailable({ capability: 'tunnels' }, 'capability'),
      'edit Tunnels'
    )
  }
  try {
    return await deps.adapter.findZone(opened.token, {
      accountId: owner.externalAccountId,
      hostname: name,
    })
  } catch (err) {
    throw providerRefusal(err)
  }
}

/** The zone a set of names lives in; they must all share one (a site pins one certificate). */
async function singleZone(
  deps: VerifyOriginDeps,
  owner: CarrierRow,
  names: readonly string[]
): Promise<{ id: string; name: string }> {
  const zones = await Promise.all(names.map((n) => zoneOf(deps, owner, n)))
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
  const zone = await singleZone(deps, owner, names)
  const picked = pickBadges(await listBadges(deps.db, owner.id), {
    capability: 'certificates',
    zone,
  })
  const badge = picked.badges[0]
  if (!badge) {
    throw badgeRefusal(
      new BadgeUnavailable({ capability: 'certificates', zone }, picked.missing ?? 'capability'),
      'manage certificates'
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
  row: TunnelRow
): Promise<VerifyState> {
  const state = await tunnelVerifyState(deps.db, row)
  if (!row.externalId) return state
  const hostnames = await routeNames(deps.db, row.id, null)
  try {
    await useBadges(deps.db, deps.secrets, owner.id, { capability: 'tunnels' }, (token) =>
      deps.adapter.setRoutes(token, {
        accountId: owner.externalAccountId,
        externalId: row.externalId!,
        hostnames,
        verifyOrigin: state.active,
      })
    )
  } catch (err) {
    throw refuse(err, 'edit Tunnels')
  }
  return state
}

/**
 * Before anything is issued: a wildcard covers the zone and one label below it,
 * so a site with a deeper name is refused up front rather than after other
 * sites already got certificates.
 */
async function assertWildcardReaches(
  deps: VerifyOriginDeps,
  owner: CarrierRow,
  hostingIds: readonly string[]
): Promise<void> {
  await mapSequential(hostingIds, async (hostingId) => {
    const names = await hostingNames(deps.db, hostingId)
    const zone = await singleZone(deps, owner, names)
    const covered = originCertificateNames(zone.name)
    if (!names.every((name) => coversHostname(covered, name))) {
      throw new TunnelRefusal(
        'verify_origin_names',
        409,
        `A wildcard certificate covers one label below the zone, and a site serves a deeper name than that (${names.join(', ')}). Use certificates for exact hostnames instead`
      )
    }
  })
}

/** One site after another, at most `MAX_CERTIFICATES_PER_VERIFY` new certificates; the rest are deferred. */
async function certifyAll(
  deps: VerifyOriginDeps,
  owner: CarrierRow,
  input: {
    hostingIds: readonly string[]
    tunnelNames: ReadonlySet<string>
    scope: OriginCertificateScope
    result: VerifyOriginResult
  }
): Promise<void> {
  const { hostingIds, tunnelNames, scope, result } = input
  if (scope === 'wildcard') await assertWildcardReaches(deps, owner, hostingIds)
  let issued = 0
  await mapSequential(hostingIds, async (hostingId) => {
    if (issued >= MAX_CERTIFICATES_PER_VERIFY) {
      result.deferredHostingIds.push(hostingId)
      return
    }
    const done = await certifyHosting(deps, owner, hostingId, tunnelNames, scope)
    if (!done.reused) issued += 1
    ;(done.reused ? result.reusedCertificateIds : result.issuedCertificateIds).push(done.tlsId)
    if (done.changed) result.pinnedHostingIds.push(hostingId)
  })
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
  if (!(await openBestBadge(deps.db, deps.secrets, owner.id, { capability: 'tunnels' }))) {
    throw badgeRefusal(
      new BadgeUnavailable({ capability: 'tunnels' }, 'capability'),
      'edit Tunnels'
    )
  }
  const result: VerifyOriginResult = {
    state: { enabled, active: false, pendingNames: [] },
    pinnedHostingIds: [],
    reusedCertificateIds: [],
    issuedCertificateIds: [],
    deferredHostingIds: [],
  }
  if (enabled) {
    const doorways = (await listDoorways(deps.db, row.id)).filter((d) => d.status !== 'removing')
    const tunnelNames = new Set([
      ...(await verifyOriginHostnames(deps.db, deps.organizationId)),
      ...doorways.map((d) => d.hostname),
    ])
    const hostingIds = [...new Set(doorways.flatMap((d) => (d.hostingId ? [d.hostingId] : [])))]
    await certifyAll(deps, owner, { hostingIds, tunnelNames, scope, result })
  }
  const saved = await saveOption(deps.db, row, enabled)
  result.state = await pushRoutes(deps, owner, saved)
  if (!enabled) {
    await retireUnusedOriginCertificates(
      deps.db,
      deps.organizationId,
      await verifyOriginHostnames(deps.db, deps.organizationId)
    )
  }
  return { ...result, tunnel: saved }
}
