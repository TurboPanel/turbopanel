import type { Context } from 'hono'
import { getDaemonCellRegistry, type Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import { isNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { getCommandQueue, type CommandQueue } from '../../lib/commands/queue.ts'
import type { CommandType } from '../../lib/commands/types.ts'
import {
  createCommandRecord,
  transitionCommand,
  type CommandRecord,
} from '../../lib/db/command-records.ts'
import {
  buildUserCommandExpiresAt,
  buildCommandEnqueueEnvelope,
  queuedCommandResponseBody,
} from './command-dispatch-helpers.ts'

export function assertDispatchInfrastructure(c: Context): CommandQueue | Response {
  const registry = getDaemonCellRegistry(c)
  if (!registry) {
    return c.json({ error: 'Daemon cell registry unavailable' }, 503)
  }

  const commandQueue = getCommandQueue(c)
  if (!commandQueue || isNoopCommandQueue(commandQueue)) {
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  return commandQueue
}

export async function enqueueCommandOrCompensate(
  db: Db,
  commandQueue: CommandQueue,
  record: CommandRecord,
  envelope: CommandEnvelope,
  c: Context,
): Promise<Response | null> {
  try {
    await commandQueue.enqueue(envelope)
    return null
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return c.json({ error: 'Command queue unavailable' }, 503)
  }
}

/** Create a user-actor command row, enqueue it, and return the standard queued response. */
export async function createAndEnqueueUserCommand(
  c: Context,
  db: Db,
  params: Readonly<{
    serverId: string
    actorId: string
    type: CommandType
    payload: unknown
    ttlMs: number
  }>,
): Promise<Response> {
  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return commandQueue

  const expiresAt = buildUserCommandExpiresAt(params.ttlMs)
  const record = await createCommandRecord(db, {
    serverId: params.serverId,
    actorType: 'user',
    actorId: params.actorId,
    type: params.type,
    payload: params.payload,
    expiresAt,
  })

  const envelope = buildCommandEnqueueEnvelope({
    commandId: record.id,
    serverId: params.serverId,
    type: params.type,
    queuedAt: record.queuedAt ?? record.createdAt,
  })
  const enqueueError = await enqueueCommandOrCompensate(
    db,
    commandQueue,
    record,
    envelope,
    c,
  )
  if (enqueueError) return enqueueError

  return c.json(queuedCommandResponseBody(record.id))
}
