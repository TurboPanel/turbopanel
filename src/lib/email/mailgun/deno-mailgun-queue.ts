import { resolveEmailSettings } from '../../settings/email-settings.ts'
import type { Db } from '../../../db.ts'
import { sendMailgunJob } from './send.ts'
import type { EmailJob, EmailQueue } from '../types.ts'
import { compatLogWarn } from '../../../log-compat.ts'

type DenoMailgunQueueOptions = {
  db: Db | undefined
  env: Record<string, string | undefined>
}

class DenoMailgunQueue implements EmailQueue {
  constructor(private readonly opts: DenoMailgunQueueOptions) {}

  async enqueue(job: EmailJob): Promise<void> {
    const resolved = await resolveEmailSettings(this.opts.db, this.opts.env)
    if (resolved.provider !== 'mailgun') {
      compatLogWarn('email', `Mailgun queue skipped: provider is ${resolved.provider}`)
      return
    }

    const apiKey = resolved.mailgunApiKey?.trim() ?? ''
    const domain = resolved.mailgunDomain?.trim() ?? ''
    if (apiKey === '' || domain === '') {
      compatLogWarn('email', 'Mailgun queue skipped: API key or domain not configured')
      return
    }

    const outcome = await sendMailgunJob(job, {
      apiKey,
      domain,
      from: resolved.from,
      apiBase: resolved.mailgunApiBase,
    })
    if (!outcome.ok) {
      compatLogWarn('email', `Mailgun send failed: ${outcome.error}`)
    }
  }
}

export function createDenoMailgunQueue(opts: DenoMailgunQueueOptions): EmailQueue {
  return new DenoMailgunQueue(opts)
}

export async function resolveDenoMailgunQueue(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<EmailQueue | null> {
  const resolved = await resolveEmailSettings(db, env)
  if (resolved.provider !== 'mailgun') return null

  const apiKey = resolved.mailgunApiKey?.trim() ?? ''
  const domain = resolved.mailgunDomain?.trim() ?? ''
  if (apiKey === '' || domain === '') return null

  return createDenoMailgunQueue({ db, env })
}
