import type { CommandEnqueueOptions, CommandQueue } from './queue.ts'
import type { CommandEnvelope } from './envelope.ts'

/**
 * Narrow view of the Workers `Queue` producer binding — only `send` is used.
 *
 * Declared locally, the same way `R2BucketLike` is, so this module needs no
 * Workers ambient types and stays inside the Deno type-check.
 *
 * The result is `Promise<unknown>`, not `Promise<void>`: the real Workers
 * `Queue.send()` resolves to a `QueueSendResponse`, which a `Promise<void>`
 * signature would reject. Nothing here reads it.
 */
export type CommandQueueBinding = {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<unknown>
}

class WorkersCommandQueue implements CommandQueue {
  constructor(private readonly queue: CommandQueueBinding) {}

  async enqueue(envelope: CommandEnvelope, options?: CommandEnqueueOptions): Promise<void> {
    const delaySeconds = options?.delaySeconds
    if (delaySeconds !== undefined && delaySeconds > 0) {
      await this.queue.send(envelope, { delaySeconds: Math.ceil(delaySeconds) })
      return
    }
    await this.queue.send(envelope)
  }
}

export function createWorkersCommandQueue(queue: CommandQueueBinding): CommandQueue {
  return new WorkersCommandQueue(queue)
}
