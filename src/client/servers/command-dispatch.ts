import type { Context } from 'hono'
import { getDaemonCellRegistry } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import { isNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { getCommandQueue, type CommandQueue } from '../../lib/commands/queue.ts'
import {
  transitionCommand,
  type CommandRecord,
} from '../../lib/db/command-records.ts'
import type { Db } from '../../db.ts'

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
