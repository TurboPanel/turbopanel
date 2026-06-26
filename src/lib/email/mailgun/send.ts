import { createEmailOtpEmail, createEmailVerificationLinkEmail } from '../templates.ts'
import type { EmailJob } from '../types.ts'

export type MailgunSendConfig = {
  apiKey: string
  domain: string
  from: string
}

export type MailgunSendOutcome =
  | { ok: true }
  | { ok: false; error: string; permanent: boolean }

function isPermanentMailgunStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429
}

function resolveMailgunTemplate(job: EmailJob) {
  if (job.type === 'signup-verification') {
    return createEmailVerificationLinkEmail(job.to, job.verificationUrl)
  }
  if (job.type === 'email-otp') {
    return createEmailOtpEmail(job.to, job.otp, job.otpType)
  }
  return null
}

export async function sendMailgunJob(
  job: EmailJob,
  config: MailgunSendConfig,
): Promise<MailgunSendOutcome> {
  const template = resolveMailgunTemplate(job)
  if (!template) {
    return { ok: false, error: `unknown job type: ${(job as EmailJob).type}`, permanent: true }
  }

  const body = new URLSearchParams({
    from: config.from,
    to: job.to,
    subject: template.subject,
    text: template.text,
    html: template.html,
  })

  try {
    const res = await fetch(`https://api.mailgun.net/v3/${config.domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`api:${config.apiKey}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    if (!res.ok) {
      const message = await res.text()
      return {
        ok: false,
        error: `Mailgun ${res.status}: ${message}`,
        permanent: isPermanentMailgunStatus(res.status),
      }
    }
    return { ok: true }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: errMsg, permanent: false }
  }
}
