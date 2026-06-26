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
  apiBase: string
}

class WorkersMailgunQueue implements EmailQueue {
  constructor(private readonly opts: WorkersMailgunQueueOptions) {}

  async enqueue(job: EmailJob): Promise<void> {
    const outcome = await sendMailgunJob(job, {
      apiKey: this.opts.apiKey,
      domain: this.opts.domain,
      from: this.opts.from,
      apiBase: this.opts.apiBase,
    })
    if (!outcome.ok) {
      console.error('[TurboPanel email] Mailgun send failed', {
        error: outcome.error,
        permanent: outcome.permanent,
      })
      throw new Error(outcome.error)
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
  const workersProvider = resolveWorkersEmailProvider(resolved)
  if (workersProvider !== 'mailgun') {
    return createNoopQueue()
  }

  const apiKey = resolved.mailgunApiKey?.trim() ?? ''
  const domain = resolved.mailgunDomain?.trim() ?? ''
  if (apiKey === '' || domain === '') {
    return createNoopQueue()
  }

  return createWorkersMailgunQueue({
    apiKey,
    domain,
    from: resolved.from,
    apiBase: resolved.mailgunApiBase,
  })
}
