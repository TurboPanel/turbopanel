import { createEmailVerificationLinkEmail } from '../templates.ts'
import type { EmailJob, EmailQueue } from '../types.ts'

type WorkersMailgunQueueOptions = {
  apiKey: string
  domain: string
}

class WorkersMailgunQueue implements EmailQueue {
  constructor(private readonly opts: WorkersMailgunQueueOptions) {}

  async enqueue(job: EmailJob): Promise<void> {
    if (job.type !== 'signup-verification') return

    const template = createEmailVerificationLinkEmail(job.to, job.verificationUrl)
    const body = new URLSearchParams({
      from: job.from,
      to: job.to,
      subject: template.subject,
      text: template.text,
      html: template.html,
    })

    try {
      const res = await fetch(`https://api.mailgun.net/v3/${this.opts.domain}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`api:${this.opts.apiKey}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })
      if (!res.ok) {
        const message = await res.text()
        console.error('[TurboPanel email] Mailgun send failed', {
          status: res.status,
          statusText: res.statusText,
          message,
        })
      }
    } catch (error) {
      console.error('[TurboPanel email] Mailgun send error', error)
    }
  }
}

export function createWorkersMailgunQueue(opts: WorkersMailgunQueueOptions): EmailQueue {
  return new WorkersMailgunQueue(opts)
}
