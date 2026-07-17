import {
  resolveEmailSettings,
} from '../../settings/email-settings.ts'
import type { DerivedSecretsConfig } from '../../../client/authn/secrets.ts'
import type { Db } from '../../../db.ts'
import { resolveMailpitApiBaseUrl, sendMailpitJob } from '../mailpit/send.ts'
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

type WorkersMailpitQueueOptions = {
  apiBaseUrl: string
  from: string
}

class WorkersMailpitQueue implements EmailQueue {
  constructor(private readonly opts: WorkersMailpitQueueOptions) {}

  async enqueue(job: EmailJob): Promise<void> {
    const outcome = await sendMailpitJob(job, {
      apiBaseUrl: this.opts.apiBaseUrl,
      from: this.opts.from,
    })
    if (!outcome.ok) {
      console.error('[TurboPanel email] Mailpit send failed', {
        error: outcome.error,
        permanent: outcome.permanent,
      })
      throw new Error(outcome.error)
    }
  }
}

export function createWorkersMailpitQueue(opts: WorkersMailpitQueueOptions): EmailQueue {
  return new WorkersMailpitQueue(opts)
}

export async function resolveWorkersEmailQueue(
  db: Db | undefined,
  env: Record<string, string | undefined>,
  dataEncryptionSecrets?: DerivedSecretsConfig,
): Promise<EmailQueue> {
  const resolved = await resolveEmailSettings(db, env, dataEncryptionSecrets)
  const workersProvider = resolved.provider
  if (workersProvider === 'mailpit') {
    return createWorkersMailpitQueue({
      apiBaseUrl: resolveMailpitApiBaseUrl(env),
      from: resolved.from,
    })
  }
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
