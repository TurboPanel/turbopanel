import { eq } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { setting } from '../db/schema.ts'

export type SmtpConfig = {
  host: string
  port: number
  user?: string
  pass?: string
}

export type SmtpRuntimeEnv = {
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_USER?: string
  SMTP_PASS?: string
  SMTP_FROM?: string
  TURBOPANEL_SYSTEM_EMAIL_FROM?: string
}

export function smtpEnvOverrideActive(env: SmtpRuntimeEnv): boolean {
  const host = env.SMTP_HOST?.trim() ?? ''
  const port = env.SMTP_PORT?.trim() ?? ''
  return host !== '' && port !== ''
}

export function smtpConfigFromRuntimeEnv(env: SmtpRuntimeEnv): SmtpConfig | undefined {
  const host = env.SMTP_HOST?.trim() ?? ''
  const portRaw = env.SMTP_PORT?.trim() ?? ''
  if (host === '' || portRaw === '') return undefined

  const port = Number.parseInt(portRaw, 10)
  if (Number.isNaN(port)) return undefined

  const user = env.SMTP_USER?.trim() ?? ''
  const pass = env.SMTP_PASS
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
  if (smtpEnvOverrideActive(runtimeEnv)) {
    return smtpConfigFromRuntimeEnv(runtimeEnv)
  }

  const host = (await getSetting(db, 'SMTP_HOST'))?.trim() ?? ''
  const portRaw = (await getSetting(db, 'SMTP_PORT'))?.trim() ?? ''
  if (host === '' || portRaw === '') return undefined

  const port = Number.parseInt(portRaw, 10)
  if (Number.isNaN(port)) return undefined

  const user = (await getSetting(db, 'SMTP_USER'))?.trim() ?? ''
  const passRaw = await getSetting(db, 'SMTP_PASS')
  const pass = passRaw === null || passRaw === '' ? undefined : passRaw
  return {
    host,
    port,
    ...(user !== '' ? { user } : {}),
    ...(pass !== undefined ? { pass } : {}),
  }
}

export async function resolveSelfHostedMailFromAddress(
  db: Db,
  runtimeEnv: SmtpRuntimeEnv,
): Promise<string> {
  const fromDb = (await getSetting(db, 'SMTP_FROM'))?.trim() ?? ''
  if (fromDb !== '') return fromDb

  const fromEnv = runtimeEnv.TURBOPANEL_SYSTEM_EMAIL_FROM?.trim() ||
    runtimeEnv.SMTP_FROM?.trim() || ''
  if (fromEnv !== '') return fromEnv

  return 'noreply@turbopanel.local'
}

async function getSetting(db: Db, k: string): Promise<string | null> {
  const rows = await db.select().from(setting).where(eq(setting.key, k)).limit(1)
  return rows[0]?.value ?? null
}
