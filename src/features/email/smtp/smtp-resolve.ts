import type { Db } from '../../../db/connection.ts'
import { resolveEmailSettings } from '../../settings/email-settings.ts'

export type SmtpConfig = {
  host: string
  port: number
  user?: string
  pass?: string
}

export type SmtpRuntimeEnv = Record<string, string | undefined>

export function parseExplicitSmtpConfig(
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

export function smtpEnvOverrideActive(env: SmtpRuntimeEnv): boolean {
  const host = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST?.trim() ?? ''
  const port = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT?.trim() ?? ''
  return host !== '' && port !== ''
}

export function smtpConfigFromRuntimeEnv(env: SmtpRuntimeEnv): SmtpConfig | undefined {
  const host = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST ?? ''
  const portRaw = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT ?? ''
  const user = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_USER ?? ''
  const pass = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS
  return parseExplicitSmtpConfig(host, portRaw, user, pass)
}

export async function resolveSelfHostedSmtpConfig(
  db: Db,
  runtimeEnv: SmtpRuntimeEnv,
): Promise<SmtpConfig | undefined> {
  const resolved = await resolveEmailSettings(db, runtimeEnv)
  if (resolved.provider !== 'smtp') return undefined
  return resolved.smtp
}

export async function resolveSelfHostedMailFromAddress(
  db: Db,
  runtimeEnv: SmtpRuntimeEnv,
): Promise<string> {
  const resolved = await resolveEmailSettings(db, runtimeEnv)
  return resolved.from
}
