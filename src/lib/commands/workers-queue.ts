import type { CommandQueue } from './queue.ts'
import type { CommandEnvelope } from './envelope.ts'

/**
 * Narrow view of the Workers `Queue` producer binding — only `send` is used.
 *
 * Declared locally, the same way `PipelineLike` is, so this module needs no
 * Workers ambient types and stays inside the Deno type-check.
 *
 * The result is `Promise<unknown>`, not `Promise<void>`: the real Workers
 * `Queue.send()` resolves to a `QueueSendResponse`, which a `Promise<void>`
 * signature would reject. Nothing here reads it.
 */
export type CommandQueueBinding = {
  send(message: unknown): Promise<unknown>
}

class WorkersCommandQueue implements CommandQueue {
  constructor(private readonly queue: CommandQueueBinding) {}

  async enqueue(envelope: CommandEnvelope): Promise<void> {
    await this.queue.send(envelope)
  }
}

export function createWorkersCommandQueue(
  queue: CommandQueueBinding,
): CommandQueue {
  return new WorkersCommandQueue(queue)
}
