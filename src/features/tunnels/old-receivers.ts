/**
 * Servers that run a site behind a tunnel but whose daemon lacks
 * `tunnel-peer-mtls-v1`. A sender that has it dials the peer port (9443) and an
 * older receiver answers nothing there, so visitors get a 503 until the
 * receiver's daemon is updated. Said in plain words, by server and by name.
 */
import { inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { daemonTakesPeerClientAuth } from './daemon-gate.ts'
import { loadRoutingFacts } from './route-facts.ts'
import type { TunnelFact } from './route-builder.ts'
import { compareText } from './order.ts'

/** Hostnames (sorted) that an old receiver, by server id, cannot be reached for. */
export type OldReceivers = Map<string, string[]>

/**
 * Pure: for every site server without the feature, the names of its sites that
 * some other carrying server with the feature would send to.
 */
export function oldReceiversOf(
  tunnels: readonly TunnelFact[],
  takesPeerAuth: ReadonlySet<string>
): OldReceivers {
  const found = new Map<string, Set<string>>()
  for (const tunnel of tunnels) {
    for (const doorway of tunnel.doorways) {
      for (const receiver of doorway.siteServerIds) {
        if (takesPeerAuth.has(receiver)) continue
        if (!tunnel.carrying.some((sender) => sender !== receiver && takesPeerAuth.has(sender))) {
          continue
        }
        found.set(receiver, (found.get(receiver) ?? new Set()).add(doorway.hostname))
      }
    }
  }
  return new Map(
    [...found].map(([id, names]) => [id, [...names].toSorted(compareText)] as [string, string[]])
  )
}

/** The plain-words line for one server, naming the affected hostnames. */
export function oldReceiverMessage(serverName: string, hostnames: readonly string[]): string {
  const names = hostnames.join(', ')
  const noun = hostnames.length === 1 ? 'the name' : 'these names'
  return `${serverName} needs a daemon update before tunnels can reach it: visitors to ${noun} ${names} get an error until it is updated.`
}

/** Names of servers by id; a server without a name shows its id. */
export async function serverLabels(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, string>> {
  if (serverIds.length === 0) return new Map()
  const rows = await db
    .select({ id: server.id, name: server.name, hostname: server.hostname })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  return new Map(rows.map((r) => [r.id, r.name || r.hostname || r.id]))
}

/** Every old receiver of the organization's tunnels, from the stored daemon features. */
export async function loadOldReceivers(db: Db, organizationId: string): Promise<OldReceivers> {
  const facts = await loadRoutingFacts(db, organizationId)
  const involved = new Set<string>()
  for (const t of facts.tunnels) {
    t.carrying.forEach((id) => involved.add(id))
    t.doorways.forEach((d) => d.siteServerIds.forEach((id) => involved.add(id)))
  }
  const takes = new Set<string>()
  await Promise.all(
    [...involved].map(async (id) => {
      const state = await getServerDaemonStateByServerId(db, id)
      if (daemonTakesPeerClientAuth(state?.projection?.features)) takes.add(id)
    })
  )
  return oldReceiversOf(facts.tunnels, takes)
}

/**
 * What the hostname list and the tunnel show: per name, the line naming the
 * servers that need an update, and per tunnel the same lines by server.
 */
export async function oldReceiverNotes(
  db: Db,
  organizationId: string,
  hostnames: readonly string[]
): Promise<{ byHostname: Map<string, string>; lines: string[] }> {
  const wanted = new Set(hostnames)
  const receivers = await loadOldReceivers(db, organizationId)
  const labels = await serverLabels(db, [...receivers.keys()])
  const byHostname = new Map<string, string>()
  const lines: string[] = []
  for (const [id, names] of [...receivers].toSorted(([a], [b]) => compareText(a, b))) {
    const mine = names.filter((n) => wanted.has(n))
    if (mine.length === 0) continue
    const label = labels.get(id) ?? id
    lines.push(oldReceiverMessage(label, mine))
    for (const name of mine) {
      byHostname.set(
        name,
        `${label} needs a daemon update before tunnels can reach this name; visitors get an error until it is updated.`
      )
    }
  }
  return { byHostname, lines }
}
