/**
 * Sends each server the connectors of the tunnels it should carry, and takes
 * them off servers that should not carry them any more.
 *
 * What a server should run is rebuilt from the database: every tunnel of the
 * organization that has a provider id and a run token, and whose placement
 * names the server (`carryingServers`). The panel remembers, per server, the
 * hash of the last list it sent, the command that carried it and the provider
 * ids it asked the server to run (`server.metadata.tunnelConnectors`); a
 * tunnel that is gone or moved off a server is removed from that remembered
 * list. Only the connectors this code installed are ever removed, so the
 * instance's own tunnel and any hand-placed connector stay alone.
 *
 * The run token leaves the database only inside a `tpdaemon.` envelope sealed
 * for the one server, and appears in no log line. A resend is harmless: the
 * daemon leaves a connector that already runs as it is. The consumer does not
 * queue commands for a disconnected server, so the sweep sends again until a
 * command finishes well.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, secret, server, tunnel } from '../../db/schema.ts'
import { resealSecretForDaemon } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { TUNNEL_CONNECTOR_FEATURE } from '../../lib/version-wire.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { TunnelConnectorsCommandPayload } from '../../contracts/commands/tunnel-connectors.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import { getServerDaemonStateByServerId, isDaemonKeyActive } from '../servers/server-identity-db.ts'
import { carryingServers, listTunnels } from './lifecycle.ts'
import { compareText } from './order.ts'

/** The least time between two sends of the same list to one server. */
export const TUNNEL_CONNECTORS_RESEND_GAP_MS = 10 * 60 * 1000

/** How long a command that has not finished is trusted before the list is sent again. */
export const TUNNEL_CONNECTORS_STALE_MS = 10 * 60 * 1000

const PROVIDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type TunnelConnectorsDeps = Readonly<{
  commandQueue: CommandQueue
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}>

export type TunnelConnectorsOutcome =
  | { status: 'sent'; commandId: string }
  | { status: 'unchanged' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

type SentState = {
  stateHash: string
  commandId: string
  sentAt: string
  /** Provider ids the server was asked to run, sorted. */
  installed: string[]
}

/** One connector a server should run: the provider's tunnel id and the run token's secret row. */
export type WantedConnector = { tunnelId: string; secretId: string }

function readSentState(metadata: unknown): SentState | null {
  const raw = (metadata as { tunnelConnectors?: Partial<SentState> } | null)?.tunnelConnectors
  if (
    raw &&
    typeof raw.stateHash === 'string' &&
    typeof raw.commandId === 'string' &&
    typeof raw.sentAt === 'string' &&
    Array.isArray(raw.installed) &&
    raw.installed.every((id) => typeof id === 'string')
  ) {
    return {
      stateHash: raw.stateHash,
      commandId: raw.commandId,
      sentAt: raw.sentAt,
      installed: raw.installed,
    }
  }
  return null
}

async function recordSent(db: Db, serverId: string, state: SentState): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(coalesce(${server.metadata}, '{}'::jsonb), '{tunnelConnectors}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(eq(server.id, serverId))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Which connectors every server of the organization should run, by server id. */
export async function wantedConnectorsByServer(
  db: Db,
  organizationId: string
): Promise<Map<string, WantedConnector[]>> {
  const wanted = new Map<string, WantedConnector[]>()
  const rows = await listTunnels(db, organizationId)
  await Promise.all(
    rows.map(async (row) => {
      if (!row.externalId || !row.secretId || !PROVIDER_ID_RE.test(row.externalId)) return
      for (const serverId of await carryingServers(db, row)) {
        const list = wanted.get(serverId) ?? []
        list.push({ tunnelId: row.externalId, secretId: row.secretId })
        wanted.set(serverId, list)
      }
    })
  )
  for (const [serverId, list] of wanted) {
    wanted.set(
      serverId,
      list.toSorted((a, b) => compareText(a.tunnelId, b.tunnelId))
    )
  }
  return wanted
}

async function hashList(install: readonly WantedConnector[], remove: readonly string[]) {
  return await sha256Hex(
    JSON.stringify({
      install: install.map((entry) => [entry.tunnelId, entry.secretId]),
      remove,
    })
  )
}

type ServerReady =
  { ok: true; metadata: unknown; keyId: string } | { ok: false; outcome: TunnelConnectorsOutcome }

/** The server exists, is connected, and runs a daemon that can install connectors. */
async function checkServerReady(
  db: Db,
  organizationId: string,
  serverId: string
): Promise<ServerReady> {
  const skip = (reason: string): ServerReady => ({
    ok: false,
    outcome: { status: 'skipped', reason },
  })
  const [row] = await db
    .select({ isConnected: server.isConnected, metadata: server.metadata })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  if (!row) return skip('unknown server')
  if (!row.isConnected) return skip('server offline')
  const state = await getServerDaemonStateByServerId(db, serverId)
  if (state?.projection?.features?.includes(TUNNEL_CONNECTOR_FEATURE) !== true) {
    return skip('daemon too old')
  }
  if (!state.key || !isDaemonKeyActive(state.key)) return skip('daemon key unavailable')
  return { ok: true, metadata: row.metadata, keyId: state.key.id }
}

async function loadLastSend(db: Db, state: SentState) {
  const [row] = await db
    .select({ status: command.status })
    .from(command)
    .where(eq(command.id, state.commandId))
    .limit(1)
  return row
}

/**
 * Is the list already where it should be? A list that finished is left alone.
 * One that did not finish waits out the gap before it is sent again, so a list
 * the server keeps refusing is not sealed and sent on every tick.
 */
async function isAlreadyCurrent(
  db: Db,
  sent: SentState | null,
  stateHash: string,
  nothingToDo: boolean
): Promise<boolean> {
  if (sent === null) return nothingToDo
  if (sent.stateHash !== stateHash) return false
  const last = await loadLastSend(db, sent)
  if (last?.status === 'succeeded') return true
  const open = ['queued', 'dispatching', 'sent', 'acked', 'running']
  if (last && open.includes(last.status)) {
    return Date.now() - Date.parse(sent.sentAt) < TUNNEL_CONNECTORS_STALE_MS
  }
  return Date.now() - Date.parse(sent.sentAt) < TUNNEL_CONNECTORS_RESEND_GAP_MS
}

/** Seal every run token for this server alone. Null when a secret row is missing. */
async function sealInstalls(
  db: Db,
  deps: TunnelConnectorsDeps,
  params: { organizationId: string; serverId: string; keyId: string },
  install: readonly WantedConnector[]
): Promise<TunnelConnectorsCommandPayload['install'] | null> {
  const sealed: TunnelConnectorsCommandPayload['install'] = []
  for (const entry of install) {
    const [stored] = await db
      .select({ secretEnvelope: secret.secretEnvelope })
      .from(secret)
      .where(and(eq(secret.id, entry.secretId), eq(secret.organizationId, params.organizationId)))
      .limit(1)
    if (!stored) return null
    sealed.push({
      tunnelId: entry.tunnelId,
      tokenEnvelope: await resealSecretForDaemon(
        deps.secretsConfig,
        deps.dataEncryptionSecrets,
        { serverId: params.serverId, keyId: params.keyId },
        stored.secretEnvelope
      ),
    })
  }
  return sealed
}

async function enqueueConnectors(
  db: Db,
  commandQueue: CommandQueue,
  serverId: string,
  payload: TunnelConnectorsCommandPayload
): Promise<{ ok: true; commandId: string } | { ok: false; reason: string }> {
  const record = await createCommandRecord(db, {
    serverId,
    actorType: 'system',
    actorId: serverId,
    type: 'server.tunnel.connectors',
    payload,
    expiresAt: new Date(Date.now() + TUNNEL_CONNECTORS_STALE_MS).toISOString(),
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: 'server.tunnel.connectors',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, { status: 'failed', error: 'Command queue unavailable' })
    return { ok: false, reason: 'Command queue unavailable' }
  }
  return { ok: true, commandId: record.id }
}

/**
 * Bring one server up to date. `wanted` is what the server should run; when it
 * is left out it is read from the database.
 */
export async function syncServerTunnelConnectors(
  db: Db,
  deps: TunnelConnectorsDeps,
  params: { organizationId: string; serverId: string; wanted?: readonly WantedConnector[] }
): Promise<TunnelConnectorsOutcome> {
  if (isNoopCommandQueue(deps.commandQueue)) {
    return { status: 'skipped', reason: 'no command queue' }
  }
  const { organizationId, serverId } = params
  const ready = await checkServerReady(db, organizationId, serverId)
  if (!ready.ok) return ready.outcome
  const install =
    params.wanted ??
    (await wantedConnectorsByServer(db, organizationId)).get(serverId) ??
    ([] as WantedConnector[])
  const sent = readSentState(ready.metadata)
  const wantedIds = new Set(install.map((entry) => entry.tunnelId))
  const remove = (sent?.installed ?? []).filter((id) => !wantedIds.has(id)).toSorted(compareText)
  const stateHash = await hashList(install, remove)
  if (await isAlreadyCurrent(db, sent, stateHash, install.length === 0 && remove.length === 0)) {
    return { status: 'unchanged' }
  }
  if (install.length === 0 && remove.length === 0) {
    // Nothing is wanted and nothing is left to remove: remember that and stop asking.
    if (sent) {
      await recordSent(db, serverId, { ...sent, installed: [], stateHash })
    }
    return { status: 'unchanged' }
  }
  const sealed = await sealInstalls(
    db,
    deps,
    { organizationId, serverId, keyId: ready.keyId },
    install
  )
  if (!sealed) return { status: 'failed', reason: 'a run token is missing' }
  const queued = await enqueueConnectors(db, deps.commandQueue, serverId, {
    install: sealed,
    remove,
  })
  if (!queued.ok) return { status: 'failed', reason: queued.reason }
  await recordSent(db, serverId, {
    stateHash,
    commandId: queued.commandId,
    sentAt: new Date().toISOString(),
    installed: install.map((entry) => entry.tunnelId),
  })
  return { status: 'sent', commandId: queued.commandId }
}

/** Servers of the organization that should run a connector or were asked to before. */
async function serversToCheck(
  db: Db,
  organizationId: string,
  wanted: ReadonlyMap<string, readonly WantedConnector[]>
): Promise<string[]> {
  const remembered = await db
    .select({ id: server.id })
    .from(server)
    .where(
      and(
        eq(server.organizationId, organizationId),
        sql`${server.metadata} -> 'tunnelConnectors' IS NOT NULL`
      )
    )
  return [...new Set([...wanted.keys(), ...remembered.map((row) => row.id)])]
}

/** Every organization that has a tunnel, or a server that was sent connectors. */
async function organizationsToCheck(db: Db): Promise<string[]> {
  const withTunnels = await db.selectDistinct({ id: tunnel.organizationId }).from(tunnel)
  const withLists = await db
    .selectDistinct({ id: server.organizationId })
    .from(server)
    .where(sql`${server.metadata} -> 'tunnelConnectors' IS NOT NULL`)
  const ids = new Set<string>()
  for (const row of [...withTunnels, ...withLists]) if (row.id) ids.add(row.id)
  return [...ids]
}

async function syncOrganization(
  db: Db,
  deps: TunnelConnectorsDeps,
  organizationId: string
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  const wanted = await wantedConnectorsByServer(db, organizationId)
  await forEachSequential(await serversToCheck(db, organizationId, wanted), async (serverId) => {
    try {
      const outcome = await syncServerTunnelConnectors(db, deps, {
        organizationId,
        serverId,
        wanted: wanted.get(serverId) ?? [],
      })
      if (outcome.status === 'sent') sent += 1
      if (outcome.status === 'failed') {
        failed += 1
        compatLogWarn('tunnel-connectors', `server ${serverId}: ${outcome.reason}`)
      }
    } catch (err) {
      failed += 1
      compatLogWarn(
        'tunnel-connectors',
        `server ${serverId}: ${err instanceof Error ? err.message : 'failed'}`
      )
    }
  })
  return { sent, failed }
}

/** Send one organization's servers whatever connectors they are missing (after create, move or removal). */
export async function syncOrganizationTunnelConnectors(
  db: Db,
  deps: TunnelConnectorsDeps,
  organizationId: string
): Promise<{ sent: number; failed: number }> {
  return await syncOrganization(db, deps, organizationId)
}

/**
 * The sweep: send every involved server whatever it is missing. It also covers
 * a server that reconnects, because a list sent while it was offline never
 * finished. Runs from the periodic offline sweep.
 */
export async function runTunnelConnectorsSweepTick(
  db: Db,
  deps: TunnelConnectorsDeps
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  await forEachSequential(await organizationsToCheck(db), async (organizationId) => {
    const result = await syncOrganization(db, deps, organizationId)
    sent += result.sent
    failed += result.failed
  })
  return { sent, failed }
}
