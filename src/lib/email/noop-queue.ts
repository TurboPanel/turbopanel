import type { EmailJob, EmailQueue } from './types.ts'
import { compatLogWarn } from '../../log-compat.ts'

class NoopQueue implements EmailQueue {
  async enqueue(job: EmailJob): Promise<void> {
    compatLogWarn('email', `email queue unavailable — ${job.type} not sent to ${job.to}`)
  }
}

export function createNoopQueue(): EmailQueue {
  return new NoopQueue()
}

export function isNoopEmailQueue(queue: EmailQueue | undefined): boolean {
  return queue === undefined || queue.constructor.name === 'NoopQueue'
}
