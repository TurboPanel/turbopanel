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
import { doorway, hostname, hosting, organization } from '../../db/schema.ts'
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
function defaultFor(
  facts: Omit<NameOptionFacts, 'reach' | 'dnsIssuance'>,
  reach: NameOptionFacts['reach']
) {
  return nameCertificateOptions({
    ...facts,
    reach,
    // Ordering over DNS is not offered yet; the table falls back as it says.
    dnsIssuance: false,
    dnsUnavailableReason: 'ordering over DNS is not available yet',
  }).default
}

async function moveUntouchedNames(
  db: Db,
  organizationId: string,
  row: DoorwayRow,
  site: { id: string; options: unknown }
): Promise<string[]> {
  const [org] = await db
    .select({ isAcmeEnabled: organization.isAcmeEnabled })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const options = parseHostingOptions(site.options)
  const common = {
    bind: resolveHostingBind(options),
    isHttp: resolveHostingProtocol(options) === 'http',
    acmeEnabled: org?.isAcmeEnabled === true,
    covering: [],
  }
  const stored = (await loadNameCertificates(db, [site.id])).get(site.id) ?? []
  const sibling = wwwSiblingHostname(row.hostname)
  const names = stored.filter((n) => n.hostname === row.hostname || n.hostname === sibling)
  const moved: string[] = []
  for (const name of names) {
    const facts = { ...common, hostname: name.hostname }
    const before = defaultFor(facts, 'tunnel')
    const after = defaultFor(facts, 'tunnel_and_direct')
    if (name.certificate !== before || before === after) continue
    await db
      .update(hostname)
      .set({ certificate: after, tlsId: null })
      .where(and(eq(hostname.hostingId, site.id), eq(hostname.hostname, name.hostname)))
    moved.push(name.hostname)
  }
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
  let site: { id: string; options: unknown } | null = null
  if (!isLocalOnly) {
    const owned = row.hostingId
      ? await hostingIdsOfOrganization(db, [row.hostingId], organizationId)
      : new Set<string>()
    const [found] = row.hostingId
      ? await db
          .select({ id: hosting.id, options: hosting.options })
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
