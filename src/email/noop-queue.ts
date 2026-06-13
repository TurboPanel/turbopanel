import type { EmailJob, EmailQueue } from './types.ts'

class NoopQueue implements EmailQueue {
  async enqueue(job: EmailJob): Promise<void> {
    console.warn(
      `[TurboPanel email] email queue unavailable — ${job.type} not sent to ${job.to}`,
    )
  }
}

export function createNoopQueue(): EmailQueue {
  return new NoopQueue()
}
