import { compatLogWarn } from '../../../lib/log-compat.ts'

/** Matches {@link EMAIL_SETTINGS_PREFIX} in email-settings.ts (duplicated to avoid a cycle). */
const SYSTEM_EMAIL_ENV_PREFIX = 'TURBOPANEL_SYSTEM_EMAIL'

export const MAILPIT_API_URL_ENV_KEY = `${SYSTEM_EMAIL_ENV_PREFIX}__MAILPIT_API_URL`
export const MAILPIT_SMTP_PORT_ENV_KEY = `${SYSTEM_EMAIL_ENV_PREFIX}__MAILPIT_SMTP_PORT`

const LEGACY_MAILPIT_API_URL = 'MAILPIT_API_URL'
const LEGACY_MAILPIT_SMTP_PORT = 'MAILPIT_SMTP_PORT'

export const DEFAULT_MAILPIT_SMTP_HOST = '127.0.0.1'
export const DEFAULT_MAILPIT_SMTP_PORT = 1025

function warnLegacyEnv(legacy: string, replacement: string): void {
  compatLogWarn(
    'email',
    `${legacy} is deprecated; set ${replacement} instead`,
  )
}

/** Workers + settings resolver: Mailpit HTTP API base URL env aliases. */
export function normalizeMailpitApiEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env }

  if (!out[MAILPIT_API_URL_ENV_KEY]?.trim() && env[LEGACY_MAILPIT_API_URL]?.trim()) {
    warnLegacyEnv(LEGACY_MAILPIT_API_URL, MAILPIT_API_URL_ENV_KEY)
    out[MAILPIT_API_URL_ENV_KEY] = env[LEGACY_MAILPIT_API_URL]
  }

  return out
}

/** Deno `smtp` provider only — Mailpit SMTP listener when no SMTP host/port is set. */
export function normalizeMailpitSmtpEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env }

  if (!out[MAILPIT_SMTP_PORT_ENV_KEY]?.trim() && env[LEGACY_MAILPIT_SMTP_PORT]?.trim()) {
    warnLegacyEnv(LEGACY_MAILPIT_SMTP_PORT, MAILPIT_SMTP_PORT_ENV_KEY)
    out[MAILPIT_SMTP_PORT_ENV_KEY] = env[LEGACY_MAILPIT_SMTP_PORT]
  }

  return out
}

export function normalizeMailpitRuntimeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return normalizeMailpitSmtpEnv(normalizeMailpitApiEnv(env))
}

/** Parse a configured Mailpit HTTP API base URL (Workers + explicit Deno config). */
export function parseMailpitApiBaseUrl(mailpitApiUrl: string): string | undefined {
  const apiUrl = mailpitApiUrl.trim()
  if (!apiUrl) return undefined
  return apiUrl.replace(/\/$/, '')
}

/** TurboPanel High Availability (Workers): Mailpit delivery requires a full API URL. */
export function resolveWorkersMailpitApiBaseUrl(mailpitApiUrl: string): string | undefined {
  return parseMailpitApiBaseUrl(mailpitApiUrl)
}

export function resolveMailpitSmtpPort(mailpitSmtpPort: string): number {
  const portRaw = mailpitSmtpPort.trim()
  if (!portRaw) return DEFAULT_MAILPIT_SMTP_PORT
  const parsed = Number.parseInt(portRaw, 10)
  if (Number.isNaN(parsed)) return DEFAULT_MAILPIT_SMTP_PORT
  return parsed
}
