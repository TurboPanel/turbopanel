import { parseExplicitSmtpConfig, type SmtpConfig } from '../smtp/smtp-resolve.ts'
import {
  DEFAULT_MAILPIT_SMTP_HOST,
  DEFAULT_MAILPIT_SMTP_PORT,
  resolveMailpitSmtpPort,
} from './env.ts'

/** Deno `mailpit-smtp` provider — explicit SMTP_* overrides, else co-located Mailpit SMTP. */
export function buildMailpitSmtpConfig(
  smtpHost: string,
  smtpPort: string,
  mailpitSmtpPort: string,
  user: string,
  pass?: string,
): SmtpConfig {
  const explicit = parseExplicitSmtpConfig(smtpHost, smtpPort, user, pass)
  if (explicit) return explicit

  const port = resolveMailpitSmtpPort(mailpitSmtpPort)
  const effectivePort = port > 0 ? port : DEFAULT_MAILPIT_SMTP_PORT
  return { host: DEFAULT_MAILPIT_SMTP_HOST, port: effectivePort }
}
