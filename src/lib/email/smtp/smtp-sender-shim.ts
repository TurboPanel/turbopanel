import type { EmailJob } from '../types.ts'
import type { MailerSendResult } from '../sender-types.ts'

const SMTP_UNAVAILABLE = 'SMTP not available on Workers'

export type { MailerSendResult }

export class MailerSmtpSender {
  constructor(_opts: {
    db?: unknown
    env?: Record<string, string | undefined>
  }) {
    throw new Error(SMTP_UNAVAILABLE)
  }

  async sendJob(_job: EmailJob): Promise<MailerSendResult> {
    throw new Error(SMTP_UNAVAILABLE)
  }
}

export function createMailerSmtpSender(_opts: {
  db?: unknown
  env?: Record<string, string | undefined>
}): MailerSmtpSender {
  throw new Error(SMTP_UNAVAILABLE)
}
