import type { DerivedSecretsConfig } from '../../../lib/secrets/secrets.ts'
import type { EmailJob } from '../types.ts'
import type { MailerSendResult } from '../sender-types.ts'

const SMTP_UNAVAILABLE = 'SMTP not available on Workers'

export type { MailerSendResult }

export class MailerSmtpSender {
  constructor(_opts: {
    db?: unknown
    env?: Record<string, string | undefined>
    dataEncryptionSecrets?: DerivedSecretsConfig
  }) {
    throw new Error(SMTP_UNAVAILABLE)
  }

  sendJob(_job: EmailJob): Promise<MailerSendResult> {
    return Promise.reject(new Error(SMTP_UNAVAILABLE))
  }
}

export function createMailerSmtpSender(_opts: {
  db?: unknown
  env?: Record<string, string | undefined>
  dataEncryptionSecrets?: DerivedSecretsConfig
}): MailerSmtpSender {
  throw new Error(SMTP_UNAVAILABLE)
}
