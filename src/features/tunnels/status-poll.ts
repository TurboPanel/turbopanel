/**
 * Asks each server that carries a tunnel what its connectors are doing and
 * which version they run (`server.tunnel.status`), and writes the answer onto
 * the server's portal rows (`status.ts`).
 *
 * One question is open per server at a time. The panel remembers the last
 * question in `server.metadata.tunnelStatus`; on a later tick a finished answer
 * is recorded once, and a new question is sent when the last one is old enough.
 * Only a connected server whose daemon advertises `tunnel-status-v1` is asked.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { command, portal, server } from '../../db/schema.ts'
import { parseTunnelStatusResult } from '../../contracts/commands/tunnel-status.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { getServerDaemonStateByServerId } from '../servers/server-identity-db.ts'
import { daemonCanReportTunnelStatus } from './daemon-gate.ts'
import { recordTunnelStatus } from './status.ts'

/** The least time between two questions to one server. */
export const TUNNEL_STATUS_POLL_GAP_MS = 10 * 60 * 1000

/** How long an unanswered question is waited for before it is asked again. */
export const TUNNEL_STATUS_STALE_MS = 2 * 60 * 1000

type AskedState = { commandId: string; sentAt: string; recordedAt?: string }

export function readAskedState(metadata: unknown): AskedState | null {
  const raw = (metadata as { tunnelStatus?: Partial<AskedState> } | null)?.tunnelStatus
  if (raw && typeof raw.commandId === 'string' && typeof raw.sentAt === 'string') {
    return {
      commandId: raw.commandId,
      sentAt: raw.sentAt,
      ...(typeof raw.recordedAt === 'string' ? { recordedAt: raw.recordedAt } : {}),
    }
  }
  return null
}

async function saveAsked(db: Db, serverId: string, state: AskedState): Promise<void> {
  await db
    .update(server)
    .set({
      metadata: sql`jsonb_set(coalesce(${server.metadata}, '{}'::jsonb), '{tunnelStatus}', ${JSON.stringify(state)}::jsonb)`,
    })
    .where(eq(server.id, serverId))
}

/** Record the answer of the last question once; true when it was recorded now. */
async function recordAnswer(db: Db, serverId: string, asked: AskedState): Promise<boolean> {
  const [row] = await db
    .select({ status: command.status, resultSummary: command.resultSummary })
    .from(command)
    .where(eq(command.id, asked.commandId))
    .limit(1)
  if (row?.status !== 'succeeded' || row.resultSummary === null) return false
  let result
  try {
    result = parseTunnelStatusResult(row.resultSummary)
  } catch {
    return false
  }
  await recordTunnelStatus(db, serverId, result)
  await saveAsked(db, serverId, { ...asked, recordedAt: new Date().toISOString() })
  return true
}

async function ask(db: Db, commandQueue: CommandQueue, serverId: string): Promise<void> {
  const record = await createCommandRecord(db, {
    serverId,
    actorType: 'system',
    actorId: serverId,
    type: 'server.tunnel.status',
    payload: {},
    expiresAt: new Date(Date.now() + TUNNEL_STATUS_STALE_MS).toISOString(),
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: 'server.tunnel.status',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, { status: 'failed', error: 'Command queue unavailable' })
    return
  }
  await saveAsked(db, serverId, { commandId: record.id, sentAt: new Date().toISOString() })
}

/** Record what the last question learned, then ask again when it is time. */
export async function pollServerTunnelStatus(
  db: Db,
  commandQueue: CommandQueue,
  row: { id: string; metadata: unknown },
  nowMs: number = Date.now()
): Promise<'asked' | 'recorded' | 'waiting' | 'skipped'> {
  const state = await getServerDaemonStateByServerId(db, row.id)
  if (!daemonCanReportTunnelStatus(state?.projection?.features)) return 'skipped'
  let asked = readAskedState(row.metadata)
  let recorded = false
  if (asked && !asked.recordedAt) {
    recorded = await recordAnswer(db, row.id, asked)
    if (recorded) asked = { ...asked, recordedAt: new Date(nowMs).toISOString() }
  }
  if (asked) {
    const age = nowMs - Date.parse(asked.sentAt)
    const answered = asked.recordedAt !== undefined
    // An answered question waits out the gap; an unanswered one waits out its own life.
    if (age < (answered ? TUNNEL_STATUS_POLL_GAP_MS : TUNNEL_STATUS_STALE_MS)) {
      return recorded ? 'recorded' : 'waiting'
    }
  }
  await ask(db, commandQueue, row.id)
  return 'asked'
}

/** Servers that carry a tunnel (they have a portal row) and are connected now. */
async function serversToPoll(db: Db) {
  return await db
    .selectDistinct({ id: server.id, metadata: server.metadata })
    .from(portal)
    .innerJoin(server, eq(portal.serverId, server.id))
    .where(eq(server.isConnected, true))
}

/** The sweep: ask every connected server that carries a tunnel. */
export async function runTunnelStatusPollTick(
  db: Db,
  commandQueue: CommandQueue
): Promise<{ asked: number; recorded: number }> {
  if (isNoopCommandQueue(commandQueue)) return { asked: 0, recorded: 0 }
  let asked = 0
  let recorded = 0
  await forEachSequential(await serversToPoll(db), async (row) => {
    try {
      const outcome = await pollServerTunnelStatus(db, commandQueue, row)
      if (outcome === 'asked') asked += 1
      if (outcome === 'recorded') recorded += 1
    } catch (err) {
      compatLogWarn(
        'tunnel-status',
        `server ${row.id}: ${err instanceof Error ? err.message : err}`
      )
    }
  })
  return { asked, recorded }
}
