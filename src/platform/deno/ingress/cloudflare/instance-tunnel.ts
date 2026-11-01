/**
 * What the control plane's own tunnel is doing, for Admin › Access › Tunnel.
 * Two halves that work apart: the connector on the control plane host (from
 * the daemon's `server.tunnel.status` answer, entry `instance`, also for a
 * pasted run token), and the tunnel at Cloudflare (health, edge locations,
 * routed names), which needs a connected account. Never returns a token.
 */
import { eq } from 'drizzle-orm'
import { resolveColocatedServerId } from '../../../../client/authn/install-state.ts'
import { parseTunnelStatusResult } from '../../../../contracts/commands/tunnel-status.ts'
import type { DaemonCellRegistry } from '../../../../contracts/cell.ts'
import type { Db } from '../../../../db/connection.ts'
import { command, server } from '../../../../db/schema.ts'
import type { CommandQueue } from '../../../../features/commands/queue.ts'
import { CloudflareClient } from '../../../../features/tunnels/cloudflare-client.ts'
import { firstSequential } from '../../../../lib/sequential.ts'
import { pollServerTunnelStatus, readAskedState } from '../../../../features/tunnels/status-poll.ts'
import { type IngressAccountRecord, zoneForName } from '../accounts.ts'
import type { HostnameWithState } from '../provider.ts'
import { dnsName, readTunnelState, tunnelIdFromTarget } from './tunnel-config.ts'

export type ConnectorView = {
  status: string
  version: string
  pinnedVersion: string
  slot: string
  lastUpdate: { outcome: string; at: string; reason?: string } | null
  checkedAt: string | null
}

export type EdgeView = {
  tunnelId: string
  tunnelName: string
  status: string
  connections: number
  locations: string[]
  hostnames: string[]
  checkedAt: string
}

export type InstanceTunnelView = {
  connector: ConnectorView | null
  /** Why the connector half is empty, in sentence case; null when it is filled. */
  connectorNote: string | null
  edge: EdgeView | null
  edgeNote: string | null
}

async function colocatedServer(db: Db, registry: DaemonCellRegistry) {
  const id = await resolveColocatedServerId(db, registry)
  if (!id) return null
  const [row] = await db
    .select({ id: server.id, metadata: server.metadata })
    .from(server)
    .where(eq(server.id, id))
  return row ?? null
}

/** The `instance` connector from the daemon's last answer. */
export async function readInstanceConnector(
  db: Db,
  registry: DaemonCellRegistry
): Promise<{ connector: ConnectorView | null; note: string | null }> {
  const row = await colocatedServer(db, registry)
  if (!row)
    return { connector: null, note: 'The daemon on the control plane host is not connected.' }
  const asked = readAskedState(row.metadata)
  if (!asked) return { connector: null, note: 'The connector has not been checked yet.' }
  const [answer] = await db
    .select({
      status: command.status,
      result: command.resultSummary,
      finishedAt: command.finishedAt,
    })
    .from(command)
    .where(eq(command.id, asked.commandId))
  if (answer?.status !== 'succeeded')
    return { connector: null, note: 'Waiting for the daemon to answer.' }
  const result = parseTunnelStatusResult(answer.result)
  const entry = result.connectors.find((item) => item.tunnelId === 'instance')
  if (!entry)
    return { connector: null, note: 'No tunnel connector runs on the control plane host.' }
  return {
    connector: {
      status: entry.status,
      version: entry.version,
      pinnedVersion: result.pinnedVersion,
      slot: entry.slot,
      lastUpdate: entry.lastUpdate ?? null,
      checkedAt: answer.finishedAt ?? asked.recordedAt ?? null,
    },
    note: null,
  }
}

/** Ask the co-located daemon again (at most every few minutes; see `status-poll.ts`). */
export async function refreshInstanceConnector(
  db: Db,
  registry: DaemonCellRegistry,
  queue: CommandQueue
): Promise<void> {
  const row = await colocatedServer(db, registry)
  if (row) await pollServerTunnelStatus(db, queue, row)
}

/** The tunnel id: from an applied hostname, else from a name's CNAME in the account's zones. */
async function findTunnelId(
  api: CloudflareClient,
  account: IngressAccountRecord,
  hostnames: readonly HostnameWithState[]
): Promise<string | null> {
  const applied = hostnames.map((row) => readTunnelState(row.providerState)).find(Boolean)
  if (applied) return applied.tunnelId
  const found = await firstSequential(hostnames, async (row) => {
    const name = dnsName(row.host)
    const zone = name ? zoneForName(account.scopes?.zones ?? [], name) : null
    if (!name || !zone) return undefined
    const records = await api.listDnsRecords(zone.id, name)
    return records.map((record) => tunnelIdFromTarget(record.content)).find(Boolean) ?? undefined
  })
  return found ?? null
}

export async function readEdgeTunnel(input: {
  account: IngressAccountRecord
  token: string
  fetch: typeof fetch
  hostnames: readonly HostnameWithState[]
  now: Date
}): Promise<{ edge: EdgeView | null; note: string | null }> {
  const { account } = input
  if (!account.accountId) return { edge: null, note: 'The Cloudflare account has no tunnel scope.' }
  const api = new CloudflareClient({ token: input.token, fetch: input.fetch })
  const tunnelId = await findTunnelId(api, account, input.hostnames)
  if (!tunnelId)
    return { edge: null, note: 'No hostname of this control plane points at a tunnel yet.' }
  const detail = await api.getTunnel(account.accountId, tunnelId)
  const rules = await api.getConfiguration(account.accountId, tunnelId)
  const connections = detail.connections ?? []
  return {
    edge: {
      tunnelId,
      tunnelName: detail.name,
      status: detail.status ?? 'inactive',
      connections: connections.length,
      locations: [...new Set(connections.flatMap((item) => item.colo_name ?? []))].sort(),
      hostnames: rules.flatMap((rule) => rule.hostname ?? []),
      checkedAt: input.now.toISOString(),
    },
    note: null,
  }
}
