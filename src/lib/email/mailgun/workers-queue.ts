import {
  resolveEmailSettings,
  resolveWorkersEmailProvider,
} from '../../settings/email-settings.ts'
import type { Db } from '../../../db.ts'
import { createNoopQueue } from '../noop-queue.ts'
import type { EmailJob, EmailQueue } from '../types.ts'
import { sendMailgunJob } from './send.ts'

type WorkersMailgunQueueOptions = {
  apiKey: string
  domain: string
  from: string
}

class WorkersMailgunQueue implements EmailQueue {
  constructor(private readonly opts: WorkersMailgunQueueOptions) {}

  async enqueue(job: EmailJob): Promise<void> {
    const outcome = await sendMailgunJob(job, {
      apiKey: this.opts.apiKey,
      domain: this.opts.domain,
      from: this.opts.from,
    })
    if (!outcome.ok) {
      console.error('[TurboPanel email] Mailgun send failed', {
        error: outcome.error,
        permanent: outcome.permanent,
      })
    }
  }
}

export function createWorkersMailgunQueue(opts: WorkersMailgunQueueOptions): EmailQueue {
  return new WorkersMailgunQueue(opts)
}

export async function resolveWorkersEmailQueue(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<EmailQueue> {
  const resolved = await resolveEmailSettings(db, env)
  if (resolveWorkersEmailProvider(resolved) !== 'mailgun') {
    return createNoopQueue()
  }

  const apiKey = resolved.mailgunApiKey?.trim() ?? ''
  const domain = resolved.mailgunDomain?.trim() ?? ''
  if (apiKey === '' || domain === '') {
    return createNoopQueue()
  }

  return createWorkersMailgunQueue({ apiKey, domain, from: resolved.from })
}
