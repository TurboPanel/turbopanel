import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
  createInvitationEmail,
  createNotificationEmail,
  createServerTierNoticeEmail,
} from '../templates.ts'
import type { EmailJob } from '../types.ts'

export type MailpitSendConfig = {
  apiBaseUrl: string
  from: string
}

export type MailpitSendOutcome =
  | { ok: true }
  | { ok: false; error: string; permanent: boolean }

function isPermanentMailpitStatus(status: number): boolean {
  return status >= 400 && status < 500
}

function resolveMailpitTemplate(job: EmailJob) {
  if (job.type === 'signup-verification') {
    return createEmailVerificationLinkEmail(job.to, job.verificationUrl)
  }
  if (job.type === 'email-otp') {
    return createEmailOtpEmail(job.to, job.otp, job.otpType)
  }
  if (job.type === 'server-tier-notice') {
    return createServerTierNoticeEmail(job)
  }
  if (job.type === 'invitation') {
    return createInvitationEmail(job)
  }
  if (job.type === 'notification') {
    return createNotificationEmail(job)
  }
  return null
}

export async function sendMailpitJob(
  job: EmailJob,
  config: MailpitSendConfig,
): Promise<MailpitSendOutcome> {
  const template = resolveMailpitTemplate(job)
  if (!template) {
    return { ok: false, error: `unknown job type: ${(job as EmailJob).type}`, permanent: true }
  }

  const apiBase = config.apiBaseUrl.replace(/\/$/, '')
  const payload = {
    From: { Email: config.from },
    To: [{ Email: job.to }],
    Subject: template.subject,
    HTML: template.html,
    Text: template.text ?? template.html,
  }

  try {
    const response = await fetch(`${apiBase}/api/v1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (response.ok) {
      return { ok: true }
    }

    const message = await response.text()
    return {
      ok: false,
      error: message || `Mailpit ${response.status}`,
      permanent: isPermanentMailpitStatus(response.status),
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: errMsg, permanent: false }
  }
}
