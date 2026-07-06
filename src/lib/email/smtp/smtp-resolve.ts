import type { Db } from '../../../db.ts'
import { resolveEmailSettings } from '../../settings/email-settings.ts'

export type SmtpConfig = {
  host: string
  port: number
  user?: string
  pass?: string
}

export type SmtpRuntimeEnv = Record<string, string | undefined>

export function smtpEnvOverrideActive(env: SmtpRuntimeEnv): boolean {
  const host = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST?.trim() ?? ''
  const port = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT?.trim() ?? ''
  return host !== '' && port !== ''
}

export function smtpConfigFromRuntimeEnv(env: SmtpRuntimeEnv): SmtpConfig | undefined {
  const host = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST?.trim() ?? ''
  const portRaw = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT?.trim() ?? ''
  if (host === '' || portRaw === '') return undefined

  const port = Number.parseInt(portRaw, 10)
  if (Number.isNaN(port)) return undefined

  const user = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_USER?.trim() ?? ''
  const pass = env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS
  return {
    host,
    port,
    ...(user !== '' ? { user } : {}),
    ...(pass !== undefined && pass !== '' ? { pass } : {}),
  }
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
