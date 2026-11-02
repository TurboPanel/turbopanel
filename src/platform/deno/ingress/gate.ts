/**
 * The edge gate. An edge connection mode (a tunnel or a proxy in front of the
 * control plane) may be switched on only when every remote server has this
 * control plane's key pinned (`server.trust_pinned_by` is `install` or
 * `upgrade`). The server on the control plane host does not count: it talks
 * over the local socket, never through the edge. No remote server at all means
 * ready. The control plane decides this by itself; nobody confirms it.
 * `TURBOPANEL_EDGE_GATE=closed` keeps the gate shut whatever the servers say;
 * no value opens it.
 */
import type { Db } from '../../../db/connection.ts'
import { server } from '../../../db/schema.ts'
import { resolveColocatedServerIdSet } from '../../../client/servers/colocated.ts'

export const EDGE_GATE_ENV = 'TURBOPANEL_EDGE_GATE'

/** Pin kinds that mean the server checks this control plane's key. */
const PINNED = new Set(['install', 'upgrade'])

export type EdgeGateServer = {
  id: string
  name: string
  /** Null for a server no organization owns yet (no server page to link to). */
  organizationId: string | null
  trustPinnedBy: string | null
}

export type EdgeGateWaitingServer = Omit<EdgeGateServer, 'trustPinnedBy'> & {
  /** `unsafe` (installed with the skip flag) or null (never reported a pin). */
  pinnedBy: string | null
}

export type EdgeGate = {
  open: boolean
  /** Sentence case; set when the gate is shut. */
  reason?: string
  /** Remote servers that still need to learn this control plane's key. */
  waiting: EdgeGateWaitingServer[]
  /** How many remote servers count (the co-located one never does). */
  remoteServers: number
  /** True when the host environment keeps the gate shut. */
  forcedClosed: boolean
}

const FORCED_REASON = 'This host keeps edge connection modes off (TURBOPANEL_EDGE_GATE=closed).'

function quoteNames(waiting: readonly EdgeGateWaitingServer[]): string {
  const names = waiting.map((item) => item.name)
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

/** The sentence for a shut gate, naming the servers that hold it shut. */
export function waitingReason(waiting: readonly EdgeGateWaitingServer[]): string {
  const subject =
    waiting.length === 1 ? '1 server still needs' : `${waiting.length} servers still need`
  return `${subject} to re-learn this control plane's key before an edge mode can be used: ${quoteNames(waiting)}.`
}

/** Pure: the gate from the servers, which of them sit on the control plane host, and the environment. */
export function edgeGateFrom(
  servers: readonly EdgeGateServer[],
  colocatedIds: ReadonlySet<string>,
  envValue: string | undefined
): EdgeGate {
  const remote = servers.filter((item) => !colocatedIds.has(item.id))
  const waiting = remote
    .filter((item) => !PINNED.has(item.trustPinnedBy ?? ''))
    .map(({ trustPinnedBy, ...rest }) => ({ ...rest, pinnedBy: trustPinnedBy }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const forcedClosed = envValue?.trim().toLowerCase() === 'closed'
  const base = { waiting, remoteServers: remote.length, forcedClosed }
  if (forcedClosed) return { ...base, open: false, reason: FORCED_REASON }
  if (waiting.length > 0) return { ...base, open: false, reason: waitingReason(waiting) }
  return { ...base, open: true }
}

export async function readEdgeGate(
  db: Db,
  env: Record<string, string | undefined>
): Promise<EdgeGate> {
  const rows = await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      organizationId: server.organizationId,
      trustPinnedBy: server.trustPinnedBy,
    })
    .from(server)
  const colocated =
    rows.length === 0
      ? new Set<string>()
      : await resolveColocatedServerIdSet(
          db,
          undefined,
          rows.map((row) => row.id),
          { includeSelfHostPin: true }
        )
  const servers = rows.map(({ hostname, ...row }) => ({
    ...row,
    name: row.name ?? hostname ?? row.id,
  }))
  return edgeGateFrom(servers, colocated, env[EDGE_GATE_ENV])
}
