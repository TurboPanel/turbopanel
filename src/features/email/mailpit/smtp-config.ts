import { parseExplicitSmtpConfig, type SmtpConfig } from '../smtp/smtp-resolve.ts'
import type { SmtpSecurity } from '../smtp/smtp-security.ts'
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
  security?: SmtpSecurity
): SmtpConfig {
  // An explicit host is a real relay (this provider is accepted on any install), so it
  // honours the Encryption setting. Only the built-in localhost catcher below is plain.
  const explicit = parseExplicitSmtpConfig(smtpHost, smtpPort, user, pass, security)
  if (explicit) return explicit

  const port = resolveMailpitSmtpPort(mailpitSmtpPort)
  const effectivePort = port > 0 ? port : DEFAULT_MAILPIT_SMTP_PORT
  return { host: DEFAULT_MAILPIT_SMTP_HOST, port: effectivePort, security: 'none' }
}
