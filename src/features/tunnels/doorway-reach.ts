/**
 * Whether a tunnel name is also reachable directly. `doorway.is_local_only`
 * false puts the name in the deploy's `openHostnames`: the site's address and
 * loopback both accept it, so visitors on the datacenter network reach it
 * without the tunnel. It is allowed on a datacenter bind only: a public bind
 * already answers the world, and a local bind has no address to open.
 *
 * A name that is opened gets the default of its new reach (see
 * `name-certificate-options.ts`) when its stored choice is still the default
 * of the old one: a certificate the person picked is never replaced, and the
 * origin certificate the tunnel used would not be trusted by direct visitors.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { doorway, hostname, hosting } from '../../db/schema.ts'
import { wwwSiblingHostname } from '../../contracts/commands/hostname.ts'
import {
  parseHostingOptions,
  resolveHostingBind,
  resolveHostingProtocol,
} from '../hostings/hosting-options.ts'
import {
  nameCertificateOptions,
  type NameOptionFacts,
} from '../hostings/name-certificate-options.ts'
import { loadDnsIssuance } from '../hostings/dns-issuance.ts'
import { loadNameCertificates, syncHostingPin } from '../hostings/name-certificates.ts'
import { hostingIdsOfOrganization } from './hosting-scope.ts'
import { type DoorwayRow, TunnelRefusal } from './lifecycle.ts'

export type DoorwayReachChange = {
  doorway: DoorwayRow
  /** Names whose stored certificate moved to the default of the new reach. */
  certificateChangedNames: string[]
}

function refuseBind(bind: string): TunnelRefusal {
  const where = bind === 'public' ? 'on a public address' : 'on this server only'
  return new TunnelRefusal(
    'doorway_bind_not_datacenter',
    409,
    `A name can also be reached directly only when its site is on a datacenter network. This site is ${where}.`
  )
}

/** The default certificate of a name for one reach, from the facts the choice table reads. */
function defaultFor(facts: Omit<NameOptionFacts, 'reach'>, reach: NameOptionFacts['reach']) {
  return nameCertificateOptions({ ...facts, reach }).default
}

async function moveUntouchedNames(
  db: Db,
  organizationId: string,
  row: DoorwayRow,
  site: { id: string; serviceId: string; options: unknown }
): Promise<string[]> {
  const dnsGate = await loadDnsIssuance(db, organizationId, [site.serviceId])
  const options = parseHostingOptions(site.options)
  const common = {
    bind: resolveHostingBind(options),
    isHttp: resolveHostingProtocol(options) === 'http',
    acmeEnabled: dnsGate.acmeEnabled,
    covering: [],
  }
  const stored = (await loadNameCertificates(db, [site.id])).get(site.id) ?? []
  const sibling = wwwSiblingHostname(row.hostname)
  // A www sibling that is its own doorway and still tunnel-only keeps its choice:
  // only the name that was opened (and a sibling that rides with it) moves.
  const [ownDoorway] = sibling
    ? await db
        .select({ id: doorway.id })
        .from(doorway)
        .where(
          and(
            eq(doorway.hostingId, site.id),
            eq(doorway.hostname, sibling),
            eq(doorway.isLocalOnly, true)
          )
        )
        .limit(1)
    : []
  const names = stored.filter(
    (n) => n.hostname === row.hostname || (n.hostname === sibling && !ownDoorway)
  )
  const moves = names.flatMap((name) => {
    const facts = {
      ...common,
      hostname: name.hostname,
      ...dnsGate(site.serviceId, name.hostname),
    }
    const before = defaultFor(facts, 'tunnel')
    const after = defaultFor(facts, 'tunnel_and_direct')
    return name.certificate === before && before !== after
      ? [{ hostname: name.hostname, certificate: after }]
      : []
  })
  await Promise.all(
    moves.map((move) =>
      db
        .update(hostname)
        .set({ certificate: move.certificate, tlsId: null })
        .where(and(eq(hostname.hostingId, site.id), eq(hostname.hostname, move.hostname)))
    )
  )
  const moved = moves.map((move) => move.hostname)
  if (moved.length > 0) await syncHostingPin(db, site.id)
  return moved
}

/**
 * Open (`isLocalOnly` false) or close (true) a tunnel name for direct visitors.
 * Closing is always allowed. Opening needs a site on a datacenter bind.
 */
export async function setDoorwayLocalOnly(
  db: Db,
  organizationId: string,
  row: DoorwayRow,
  isLocalOnly: boolean
): Promise<DoorwayReachChange> {
  if (row.status === 'removing') {
    throw new TunnelRefusal('doorway_removing', 409, 'This hostname is being removed')
  }
  if (row.isLocalOnly === isLocalOnly) return { doorway: row, certificateChangedNames: [] }
  let site: { id: string; serviceId: string; options: unknown } | null = null
  if (!isLocalOnly) {
    const owned = row.hostingId
      ? await hostingIdsOfOrganization(db, [row.hostingId], organizationId)
      : new Set<string>()
    const [found] = row.hostingId
      ? await db
          .select({ id: hosting.id, serviceId: hosting.serviceId, options: hosting.options })
          .from(hosting)
          .where(eq(hosting.id, row.hostingId))
          .limit(1)
      : []
    if (!found || !owned.has(found.id)) {
      throw new TunnelRefusal(
        'doorway_no_site',
        409,
        'No site serves this hostname yet, so it cannot be reached directly'
      )
    }
    const bind = resolveHostingBind(parseHostingOptions(found.options))
    if (bind !== 'datacenter') throw refuseBind(bind)
    site = found
  }
  const [updated] = await db
    .update(doorway)
    .set({ isLocalOnly })
    .where(eq(doorway.id, row.id))
    .returning()
  const changed = site ? await moveUntouchedNames(db, organizationId, row, site) : []
  return { doorway: updated!, certificateChangedNames: changed }
}
