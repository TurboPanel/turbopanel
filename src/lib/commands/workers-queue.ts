import type { CommandQueue } from './queue.ts'
import type { CommandEnvelope } from './envelope.ts'

class WorkersCommandQueue implements CommandQueue {
  constructor(private readonly queue: Queue) {}

  async enqueue(envelope: CommandEnvelope): Promise<void> {
    await this.queue.send(envelope)
  }
}

export function createWorkersCommandQueue(queue: Queue): CommandQueue {
  return new WorkersCommandQueue(queue)
}
