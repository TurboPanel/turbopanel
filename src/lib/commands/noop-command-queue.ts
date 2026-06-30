import type { CommandQueue } from './queue.ts'
import type { CommandEnvelope } from './envelope.ts'
import { compatLogWarn } from '../../log-compat.ts'

class NoopCommandQueue implements CommandQueue {
  async enqueue(envelope: CommandEnvelope): Promise<void> {
    compatLogWarn(
      'command-queue',
      `command queue unavailable — ${envelope.type} for server ${envelope.serverId} dropped`,
    )
    throw new Error('Command queue unavailable')
  }
}

export function createNoopCommandQueue(): CommandQueue {
  return new NoopCommandQueue()
}

export function isNoopCommandQueue(queue: CommandQueue | undefined): boolean {
  return queue === undefined || queue.constructor.name === 'NoopCommandQueue'
}
