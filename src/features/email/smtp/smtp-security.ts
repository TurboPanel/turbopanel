/**
 * How the control plane secures the connection to a real SMTP relay.
 *
 * - `auto`: implicit TLS on port 465, otherwise STARTTLS is required.
 * - `tls`: implicit TLS.
 * - `starttls`: plain connect, then the server must upgrade.
 * - `none`: plain text, no upgrade attempted (a local or trusted relay only).
 *
 * Certificates are always verified. Pure and runtime-free so the Workers
 * bundle can import it.
 */
export const SMTP_SECURITY_MODES = ['auto', 'tls', 'starttls', 'none'] as const

export type SmtpSecurity = (typeof SMTP_SECURITY_MODES)[number]

export const DEFAULT_SMTP_SECURITY: SmtpSecurity = 'auto'

/** Port that speaks TLS from the first byte (SMTPS). */
export const IMPLICIT_TLS_PORT = 465

/** The mode named by `value`, or `undefined` when it is not one of the four. */
export function parseSmtpSecurityStrict(value: string): SmtpSecurity | undefined {
  const normalized = value.trim().toLowerCase()
  return (SMTP_SECURITY_MODES as readonly string[]).includes(normalized)
    ? (normalized as SmtpSecurity)
    : undefined
}

/**
 * The mode to use for a stored or env value. An empty value is `auto` (existing
 * installs have none). An unknown value also falls to `auto`, never to `none`,
 * so a typo can not turn encryption off.
 */
export function resolveSmtpSecurity(value: string | undefined): SmtpSecurity {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return DEFAULT_SMTP_SECURITY
  return parseSmtpSecurityStrict(trimmed) ?? DEFAULT_SMTP_SECURITY
}

export type SmtpTransportSecurityOptions =
  { secure: true } | { secure: false; requireTLS: true } | { secure: false; ignoreTLS: true }

/** Nodemailer connection-security options for a mode and port. */
export function smtpTransportSecurityOptions(
  security: SmtpSecurity | undefined,
  port: number
): SmtpTransportSecurityOptions {
  const mode = security ?? DEFAULT_SMTP_SECURITY
  if (mode === 'tls') return { secure: true }
  if (mode === 'starttls') return { secure: false, requireTLS: true }
  if (mode === 'none') return { secure: false, ignoreTLS: true }
  return port === IMPLICIT_TLS_PORT ? { secure: true } : { secure: false, requireTLS: true }
}
