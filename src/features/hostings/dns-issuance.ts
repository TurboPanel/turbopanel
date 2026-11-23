/**
 * Whether a name may be ordered over the DNS proof, decided in one place so the
 * choice list, the default a new or reopened name gets, and the refusal of a
 * saved choice all agree. A name qualifies when:
 * - the organization turned Let's Encrypt on,
 * - an active DNS token of the organization covers the name's zone (the zones
 *   a token was found to reach, stored on the token; no provider call), and
 * - a server that serves the site has a daemon that lists `acme-issue-dns-v1`.
 *
 * The organization's daily cap and an authority rate limit are not here: they
 * are runtime waits the order flow reports on the certificate, and a gate that
 * flipped with them would make the list jump around. Presence is not here
 * either: an offline server comes back and the order waits for it.
 *
 * One batched read per request (no query per name); pure rules over the result.
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { deployment, environment, organization, server, service } from '../../db/schema.ts'
import { ACME_ISSUE_DNS_FEATURE } from '../../lib/version-wire.ts'
import { parseServerDaemonState } from '../servers/daemon-state.ts'
import { type BadgeRow, findStoredZone, listCarriers } from '../tunnels/records.ts'
import type { NameOptionFacts } from './name-certificate-options.ts'

export type DnsIssuanceFacts = Pick<NameOptionFacts, 'dnsIssuance' | 'dnsUnavailableReason'>

/** What one site's DNS gate needs besides the name. */
export type DnsIssuanceInputs = {
  acmeEnabled: boolean
  /** The organization's DNS tokens. */
  badges: readonly BadgeRow[]
  /** How many of the servers that serve the site list the DNS order feature. */
  servers: { capable: number }
}

/** The gate for one name. Pure. */
export function dnsIssuanceFor(hostname: string, inputs: DnsIssuanceInputs): DnsIssuanceFacts {
  const refuse = (dnsUnavailableReason: string): DnsIssuanceFacts => ({
    dnsIssuance: false,
    dnsUnavailableReason,
  })
  if (!inputs.acmeEnabled) return refuse("Let's Encrypt is not turned on for this organization")
  if (findStoredZone(inputs.badges, hostname) === null) {
    return refuse(`No DNS token covers ${hostname}`)
  }
  if (inputs.servers.capable === 0) {
    return refuse('No server serving this name can order over DNS yet')
  }
  return { dnsIssuance: true }
}

/** The gate for a name of a site, by the site's service. */
export type DnsIssuanceLookup = ((serviceId: string, hostname: string) => DnsIssuanceFacts) & {
  /** The organization's Let's Encrypt switch, read once with the gate. */
  acmeEnabled: boolean
}

/** Servers that run each service: its environment's server and its live deployments. */
async function loadServerIdsByService(
  db: Db,
  serviceIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (serviceIds.length === 0) return out
  const ids = [...serviceIds]
  const [own, deployed] = await Promise.all([
    db
      .select({ serviceId: service.id, serverId: environment.serverId })
      .from(service)
      .innerJoin(environment, eq(environment.id, service.environmentId))
      .where(inArray(service.id, ids)),
    db
      .select({ serviceId: service.id, serverId: deployment.serverId })
      .from(service)
      .innerJoin(deployment, eq(deployment.environmentId, service.environmentId))
      .where(and(inArray(service.id, ids), ne(deployment.status, 'draining'))),
  ])
  for (const row of [...own, ...deployed]) {
    if (!row.serverId) continue
    const set = out.get(row.serviceId) ?? new Set<string>()
    set.add(row.serverId)
    out.set(row.serviceId, set)
  }
  return out
}

/** The servers (of those given) whose daemon lists the DNS order feature. */
async function loadCapableServerIds(db: Db, serverIds: readonly string[]): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const rows = await db
    .select({ id: server.id, daemon: server.daemon })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  return new Set(
    rows
      .filter((row) =>
        (parseServerDaemonState(row.daemon)?.projection?.features ?? []).includes(
          ACME_ISSUE_DNS_FEATURE
        )
      )
      .map((row) => row.id)
  )
}

/**
 * Read once what the gate needs for these services, and return the gate. Run
 * with the handle of the transaction when called inside one.
 */
export async function loadDnsIssuance(
  db: Db,
  organizationId: string,
  serviceIds: readonly string[]
): Promise<DnsIssuanceLookup> {
  const wanted = [...new Set(serviceIds)]
  const [[org], carriers, byService] = await Promise.all([
    db
      .select({ isAcmeEnabled: organization.isAcmeEnabled })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1),
    listCarriers(db, organizationId),
    loadServerIdsByService(db, wanted),
  ])
  const capable = await loadCapableServerIds(db, [
    ...new Set([...byService.values()].flatMap((set) => [...set])),
  ])
  const badges = carriers.flatMap((c) => c.badges)
  const acmeEnabled = org?.isAcmeEnabled === true
  const gate = (serviceId: string, hostname: string) => {
    const ids = [...(byService.get(serviceId) ?? [])]
    return dnsIssuanceFor(hostname, {
      acmeEnabled,
      badges,
      servers: { capable: ids.filter((id) => capable.has(id)).length },
    })
  }
  return Object.assign(gate, { acmeEnabled })
}
