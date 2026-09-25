import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
  createInvitationEmail,
  createNotificationEmail,
  createServerTierNoticeEmail,
} from '../../../features/email/templates.ts'
import { resolveEmailSettings, type ResolvedEmailSettings } from '../../../features/settings/email-settings.ts'
import type { DerivedSecretsConfig } from '../../secrets/secrets.ts'
import type { EmailJob } from '../../../features/email/types.ts'
import type { MailerSendResult } from '../../../features/email/sender-types.ts'
import { PermanentSendError, validateEmailAddress } from '../../../features/email/validate-address.ts'
import type { Db } from '../../../db/connection.ts'
import { buildMailpitApiBaseUrl } from '../../../features/email/mailpit/env.ts'
import { logError } from '../../logger.ts'

function validateResolvedMailpitConfig(resolved: ResolvedEmailSettings): { from: string } {
  if (resolved.provider !== 'mailpit') {
    throw new PermanentSendError(`email provider is ${resolved.provider}, not mailpit`)
  }
  return { from: resolved.from }
}

function isPermanentError(error: unknown): boolean {
  return error instanceof PermanentSendError
}

export class MailerMailpitSender {
  private readonly db: Db | undefined
  private readonly env: Record<string, string | undefined>
  private readonly dataEncryptionSecrets: DerivedSecretsConfig | undefined

  constructor(opts: {
    db: Db | undefined
    env?: Record<string, string | undefined>
    dataEncryptionSecrets?: DerivedSecretsConfig
  }) {
    this.db = opts.db
    this.env = opts.env ?? Deno.env.toObject()
    this.dataEncryptionSecrets = opts.dataEncryptionSecrets
  }

  private async resolveApiBaseUrl(): Promise<string> {
    const resolved = await resolveEmailSettings(
      this.db,
      this.env,
      this.dataEncryptionSecrets,
    )
    return buildMailpitApiBaseUrl(
      resolved.keys.MAILPIT_API_URL.value,
      resolved.keys.MAILPIT_WEB_PORT.value,
    )
  }

  private async resolveMailpitConfig(): Promise<{ from: string }> {
    const resolved = await resolveEmailSettings(
      this.db,
      this.env,
      this.dataEncryptionSecrets,
    )
    return validateResolvedMailpitConfig(resolved)
  }

  async sendJob(job: EmailJob): Promise<MailerSendResult> {
    try {
      const { from } = await this.resolveMailpitConfig()
      validateEmailAddress(from, 'from')

      let result: { subject: string; html: string; text?: string }
      switch (job.type) {
        case 'signup-verification': {
          validateEmailAddress(job.to, 'recipient')
          result = createEmailVerificationLinkEmail(job.to, job.verificationUrl)
          break
        }
        case 'email-otp': {
          validateEmailAddress(job.to, 'recipient')
          result = createEmailOtpEmail(job.to, job.otp, job.otpType)
          break
        }
        case 'server-tier-notice': {
          validateEmailAddress(job.to, 'recipient')
          result = createServerTierNoticeEmail(job)
          break
        }
        case 'invitation': {
          validateEmailAddress(job.to, 'recipient')
          result = createInvitationEmail(job)
          break
        }
        case 'notification': {
          validateEmailAddress(job.to, 'recipient')
          result = createNotificationEmail(job)
          break
        }
        default:
          return {
            success: false,
            error: `unknown job type: ${(job as EmailJob).type}`,
            permanent: true,
          }
      }

      const baseUrl = await this.resolveApiBaseUrl()
      const payload = {
        From: { Email: from },
        To: [{ Email: job.to }],
        Subject: result.subject,
        HTML: result.html,
        Text: result.text ?? result.html,
      }

      let response: Response
      try {
        response = await fetch(`${baseUrl}/api/v1/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        return { success: false, error: errMsg, permanent: false }
      }

      if (response.status >= 200 && response.status < 300) {
        return { success: true }
      }

      const responseText = await response.text()
      if (response.status >= 400 && response.status < 500) {
        return { success: false, error: responseText, permanent: true }
      }

      return { success: false, error: responseText || `HTTP ${response.status}`, permanent: false }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logError('mailer', `send failed: ${errMsg}`)
      return { success: false, error: errMsg, permanent: isPermanentError(e) }
    }
  }
}

export function createMailerMailpitSender(opts: {
  db: Db | undefined
  env?: Record<string, string | undefined>
  dataEncryptionSecrets?: DerivedSecretsConfig
}): MailerMailpitSender {
  return new MailerMailpitSender(opts)
}
