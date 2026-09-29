import { resolveEmailTemplate } from '../templates.ts'
import { EMAIL_PROVIDER_TIMEOUT_MS, type EmailJob } from '../types.ts'

export type MailpitSendConfig = {
  apiBaseUrl: string
  from: string
}

export type MailpitSendOutcome = { ok: true } | { ok: false; error: string; permanent: boolean }

function thrownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPermanentMailpitStatus(status: number): boolean {
  return status >= 400 && status < 500
}

export async function sendMailpitJob(
  job: EmailJob,
  config: MailpitSendConfig
): Promise<MailpitSendOutcome> {
  const template = resolveEmailTemplate(job)
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
      signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
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
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      ok: false,
      error: timedOut
        ? `Mailpit did not answer within ${EMAIL_PROVIDER_TIMEOUT_MS / 1000} s`
        : thrownErrorMessage(error),
      permanent: false,
    }
  }
}
