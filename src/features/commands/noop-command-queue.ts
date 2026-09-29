import type { CommandQueue } from './queue.ts'
import type { CommandEnvelope } from './envelope.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'

class NoopCommandQueue implements CommandQueue {
  enqueue(envelope: CommandEnvelope): Promise<void> {
    compatLogWarn(
      'command-queue',
      `command queue unavailable — ${envelope.type} for server ${envelope.serverId} dropped`
    )
    return Promise.reject(new Error('Command queue unavailable'))
  }
}

export function createNoopCommandQueue(): CommandQueue {
  return new NoopCommandQueue()
}

export function isNoopCommandQueue(queue: CommandQueue | undefined): boolean {
  return queue === undefined || queue.constructor.name === 'NoopCommandQueue'
}
