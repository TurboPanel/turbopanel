import { compatLogWarn } from '../../../lib/log-compat.ts'

/** Matches {@link EMAIL_SETTINGS_PREFIX} in email-settings.ts (duplicated to avoid a cycle). */
const SYSTEM_EMAIL_ENV_PREFIX = 'TURBOPANEL_SYSTEM_EMAIL'

const MAILPIT_API_URL_KEY = `${SYSTEM_EMAIL_ENV_PREFIX}__MAILPIT_API_URL`
const MAILPIT_WEB_PORT_KEY = `${SYSTEM_EMAIL_ENV_PREFIX}__MAILPIT_WEB_PORT`
const MAILPIT_SMTP_PORT_KEY = `${SYSTEM_EMAIL_ENV_PREFIX}__MAILPIT_SMTP_PORT`

const LEGACY_MAILPIT_API_URL = 'MAILPIT_API_URL'
const LEGACY_MAILPIT_WEB_PORT = 'MAILPIT_WEB_PORT'
const LEGACY_MAILPIT_SMTP_PORT = 'MAILPIT_SMTP_PORT'

export const DEFAULT_MAILPIT_WEB_PORT = 8025
export const DEFAULT_MAILPIT_SMTP_PORT = 1025

function warnLegacyEnv(legacy: string, replacement: string): void {
  compatLogWarn(
    'email',
    `${legacy} is deprecated; set ${replacement} instead`,
  )
}

/**
 * Map legacy unprefixed Mailpit env vars into `TURBOPANEL_SYSTEM_EMAIL__*` form
 * so the settings resolver and direct readers stay consistent.
 */
export function normalizeMailpitRuntimeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env }

  if (!out[MAILPIT_API_URL_KEY]?.trim() && env[LEGACY_MAILPIT_API_URL]?.trim()) {
    warnLegacyEnv(LEGACY_MAILPIT_API_URL, MAILPIT_API_URL_KEY)
    out[MAILPIT_API_URL_KEY] = env[LEGACY_MAILPIT_API_URL]
  }
  if (!out[MAILPIT_WEB_PORT_KEY]?.trim() && env[LEGACY_MAILPIT_WEB_PORT]?.trim()) {
    warnLegacyEnv(LEGACY_MAILPIT_WEB_PORT, MAILPIT_WEB_PORT_KEY)
    out[MAILPIT_WEB_PORT_KEY] = env[LEGACY_MAILPIT_WEB_PORT]
  }
  if (!out[MAILPIT_SMTP_PORT_KEY]?.trim() && env[LEGACY_MAILPIT_SMTP_PORT]?.trim()) {
    warnLegacyEnv(LEGACY_MAILPIT_SMTP_PORT, MAILPIT_SMTP_PORT_KEY)
    out[MAILPIT_SMTP_PORT_KEY] = env[LEGACY_MAILPIT_SMTP_PORT]
  }

  return out
}

export function buildMailpitApiBaseUrl(
  mailpitApiUrl: string,
  mailpitWebPort: string,
): string {
  const apiUrl = mailpitApiUrl.trim()
  if (apiUrl) {
    return apiUrl.replace(/\/$/, '')
  }

  const portRaw = mailpitWebPort.trim()
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_MAILPIT_WEB_PORT
  const effectivePort = Number.isNaN(port) ? DEFAULT_MAILPIT_WEB_PORT : port
  return `http://127.0.0.1:${effectivePort}`
}

export function resolveMailpitSmtpPort(mailpitSmtpPort: string): number {
  const portRaw = mailpitSmtpPort.trim()
  if (!portRaw) return DEFAULT_MAILPIT_SMTP_PORT
  const parsed = Number.parseInt(portRaw, 10)
  if (Number.isNaN(parsed)) return DEFAULT_MAILPIT_SMTP_PORT
  return parsed
}
