import type { SmtpConfig } from '../smtp/smtp-resolve.ts'
import {
  DEFAULT_MAILPIT_SMTP_HOST,
  DEFAULT_MAILPIT_SMTP_PORT,
  resolveMailpitSmtpPort,
} from './env.ts'

function explicitSmtpConfig(
  host: string,
  portRaw: string,
  user: string,
  pass?: string,
): SmtpConfig | undefined {
  const trimmedHost = host.trim()
  const trimmedPort = portRaw.trim()
  if (trimmedHost === '' || trimmedPort === '') return undefined

  const port = Number.parseInt(trimmedPort, 10)
  if (Number.isNaN(port)) return undefined

  const trimmedUser = user.trim()
  const trimmedPass = pass?.trim()
  return {
    host: trimmedHost,
    port,
    ...(trimmedUser !== '' ? { user: trimmedUser } : {}),
    ...(trimmedPass !== undefined && trimmedPass !== '' ? { pass: trimmedPass } : {}),
  }
}

/** Deno `mailpit-smtp` provider — explicit SMTP_* overrides, else co-located Mailpit SMTP. */
export function buildMailpitSmtpConfig(
  smtpHost: string,
  smtpPort: string,
  mailpitSmtpPort: string,
  user: string,
  pass?: string,
): SmtpConfig {
  const explicit = explicitSmtpConfig(smtpHost, smtpPort, user, pass)
  if (explicit) return explicit

  const port = resolveMailpitSmtpPort(mailpitSmtpPort)
  const effectivePort = port > 0 ? port : DEFAULT_MAILPIT_SMTP_PORT
  return { host: DEFAULT_MAILPIT_SMTP_HOST, port: effectivePort }
}
