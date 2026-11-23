import { resolveEmailSettings } from '../../settings/email-settings.ts'
import type { DerivedSecretsConfig } from '../../../lib/secrets/secrets.ts'
import type { Db } from '../../../db/connection.ts'
import { resolveWorkersMailpitApiBaseUrl } from '../mailpit/env.ts'
import { sendMailpitJob } from '../mailpit/send.ts'
import { createNoopQueue } from '../noop-queue.ts'
import type { EmailJob, EmailQueue } from '../types.ts'
import { mailgunConfigFromSettings } from './config.ts'
import { sendMailgunJob } from './send.ts'
import { EmailSendError } from '../workers-mail-queue.ts'

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
      throw new EmailSendError(outcome.error, outcome.permanent)
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
      throw new EmailSendError(outcome.error, outcome.permanent)
    }
  }
}

export function createWorkersMailpitQueue(opts: WorkersMailpitQueueOptions): EmailQueue {
  return new WorkersMailpitQueue(opts)
}

export async function resolveWorkersEmailQueue(
  db: Db | undefined,
  env: Record<string, string | undefined>,
  dataEncryptionSecrets?: DerivedSecretsConfig
): Promise<EmailQueue> {
  const resolved = await resolveEmailSettings(db, env, dataEncryptionSecrets, 'workers')
  if (resolved.provider === 'mailpit-api') {
    const apiBaseUrl = resolveWorkersMailpitApiBaseUrl(resolved.keys.MAILPIT_API_URL.value)
    if (apiBaseUrl === undefined) return createNoopQueue()
    return createWorkersMailpitQueue({ apiBaseUrl, from: resolved.from })
  }
  if (resolved.provider !== 'mailgun') return createNoopQueue()

  const config = mailgunConfigFromSettings(resolved)
  if (config === undefined) return createNoopQueue()
  return createWorkersMailgunQueue(config)
}
