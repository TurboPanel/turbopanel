import type { Db } from '../../db.ts'
import type { SmtpConfig } from '../email/smtp/smtp-resolve.ts'
import {
  deleteSettingValue,
  loadSettingValues,
  normalizeSettingFullKey,
  SettingsResolver,
  type ResolvedSetting,
  type SettingSource,
  upsertSettingValue,
} from './resolver.ts'

export const EMAIL_SETTINGS_PREFIX = 'TURBOPANEL_SYSTEM_EMAIL'

export const EMAIL_SETTING_SHORT_KEYS = [
  'PROVIDER',
  'FROM',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'RATE_LIMIT_PER_MINUTE',
  'RATE_LIMIT_BURST',
  'QUEUE_PREFETCH',
] as const

export type EmailSettingShortKey = (typeof EMAIL_SETTING_SHORT_KEYS)[number]

export type EmailProvider = 'smtp' | 'mailgun'

export const EMAIL_SETTINGS_SCHEMA: Record<EmailSettingShortKey, string | undefined> = {
  PROVIDER: 'smtp',
  FROM: 'noreply@turbopanel.local',
  MAILGUN_API_KEY: undefined,
  MAILGUN_DOMAIN: undefined,
  SMTP_HOST: undefined,
  SMTP_PORT: undefined,
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
  RATE_LIMIT_PER_MINUTE: '60',
  RATE_LIMIT_BURST: undefined,
  QUEUE_PREFETCH: '1',
}

export const EMAIL_ENV_ALIASES: Record<EmailSettingShortKey, readonly string[]> = {
  PROVIDER: [],
  FROM: ['TURBOPANEL_SYSTEM_EMAIL_FROM', 'SMTP_FROM'],
  MAILGUN_API_KEY: ['TURBOPANEL_MAILGUN_API_KEY'],
  MAILGUN_DOMAIN: ['TURBOPANEL_MAILGUN_DOMAIN'],
  SMTP_HOST: ['SMTP_HOST'],
  SMTP_PORT: ['SMTP_PORT'],
  SMTP_USER: ['SMTP_USER'],
  SMTP_PASS: ['SMTP_PASS'],
  RATE_LIMIT_PER_MINUTE: ['TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE'],
  RATE_LIMIT_BURST: [],
  QUEUE_PREFETCH: [],
}

export const EMAIL_SECRET_KEYS: ReadonlySet<EmailSettingShortKey> = new Set([
  'MAILGUN_API_KEY',
  'SMTP_PASS',
])

/** Legacy flat `setting.key` values used before hierarchical email settings. */
const LEGACY_DB_KEYS: Partial<Record<EmailSettingShortKey, string>> = {
  FROM: 'SMTP_FROM',
  SMTP_HOST: 'SMTP_HOST',
  SMTP_PORT: 'SMTP_PORT',
  SMTP_USER: 'SMTP_USER',
  SMTP_PASS: 'SMTP_PASS',
}

export type EmailSettingMeta = {
  fullKey: string
  value: string
  source: SettingSource
  isEnvOverridden: boolean
  isDbSet: boolean
}

export type ResolvedEmailSettings = {
  provider: EmailProvider
  from: string
  mailgunApiKey?: string
  mailgunDomain?: string
  smtp?: SmtpConfig
  keys: Record<EmailSettingShortKey, EmailSettingMeta>
}

function fullEmailSettingKey(shortKey: EmailSettingShortKey): string {
  return normalizeSettingFullKey(EMAIL_SETTINGS_PREFIX, shortKey)
}

function parseProvider(value: string): EmailProvider {
  return value === 'mailgun' ? 'mailgun' : 'smtp'
}

function hasConfiguredMailgunCredentials(resolved: ResolvedEmailSettings): boolean {
  const apiKey = resolved.mailgunApiKey?.trim() ?? ''
  const domain = resolved.mailgunDomain?.trim() ?? ''
  return apiKey !== '' && domain !== ''
}

/** Workers: legacy Mailgun env vars imply Mailgun when provider was never explicitly set. */
export function resolveWorkersEmailProvider(resolved: ResolvedEmailSettings): EmailProvider {
  if (resolved.provider === 'mailgun') return 'mailgun'
  if (resolved.keys.PROVIDER.source !== 'default') return resolved.provider
  return hasConfiguredMailgunCredentials(resolved) ? 'mailgun' : resolved.provider
}

function buildSmtpConfig(host: string, portRaw: string, user: string, pass?: string): SmtpConfig | undefined {
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

function metaFromResolved(
  shortKey: EmailSettingShortKey,
  resolved: ResolvedSetting,
  resolver: SettingsResolver,
): EmailSettingMeta {
  return {
    fullKey: fullEmailSettingKey(shortKey),
    value: resolved.value,
    source: resolved.source,
    isEnvOverridden: resolver.isEnvOverridden(shortKey),
    isDbSet: resolver.isDbSet(shortKey),
  }
}

async function loadEmailSettingDbValues(db: Db): Promise<Map<string, string>> {
  const fullKeys = EMAIL_SETTING_SHORT_KEYS.map((shortKey) => fullEmailSettingKey(shortKey))
  const legacyKeys = Object.values(LEGACY_DB_KEYS)
  const raw = await loadSettingValues(db, [...fullKeys, ...legacyKeys])

  const out = new Map<string, string>()
  for (const shortKey of EMAIL_SETTING_SHORT_KEYS) {
    const fullKey = fullEmailSettingKey(shortKey)
    const primary = raw.get(fullKey)
    if (primary !== undefined && primary !== '') {
      out.set(fullKey, primary)
      continue
    }
    const legacyKey = LEGACY_DB_KEYS[shortKey]
    if (!legacyKey) continue
    const legacyValue = raw.get(legacyKey)
    if (legacyValue !== undefined && legacyValue !== '') {
      out.set(fullKey, legacyValue)
    }
  }
  return out
}

async function createEmailSettingsResolver(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<SettingsResolver> {
  const dbValues = db ? await loadEmailSettingDbValues(db) : new Map<string, string>()
  return new SettingsResolver({
    prefix: EMAIL_SETTINGS_PREFIX,
    keys: EMAIL_SETTINGS_SCHEMA,
    env,
    dbValues,
    envAliases: EMAIL_ENV_ALIASES,
  })
}

export async function resolveEmailSettings(
  db: Db | undefined,
  env: Record<string, string | undefined>,
): Promise<ResolvedEmailSettings> {
  const resolver = await createEmailSettingsResolver(db, env)

  const keys = {} as Record<EmailSettingShortKey, EmailSettingMeta>
  for (const shortKey of EMAIL_SETTING_SHORT_KEYS) {
    keys[shortKey] = metaFromResolved(shortKey, resolver.resolve(shortKey), resolver)
  }

  const provider = parseProvider(keys.PROVIDER.value)
  const from = keys.FROM.value.trim() || EMAIL_SETTINGS_SCHEMA.FROM!
  const ratePerMinute = keys.RATE_LIMIT_PER_MINUTE.value.trim() ||
    EMAIL_SETTINGS_SCHEMA.RATE_LIMIT_PER_MINUTE!
  const burstRaw = keys.RATE_LIMIT_BURST.value.trim()
  const burstParsed = Number.parseInt(burstRaw, 10)
  const effectiveBurst = burstRaw !== '' && Number.isFinite(burstParsed) && burstParsed > 0
    ? burstRaw
    : ratePerMinute
  if (keys.RATE_LIMIT_BURST.value !== effectiveBurst) {
    keys.RATE_LIMIT_BURST = {
      ...keys.RATE_LIMIT_BURST,
      value: effectiveBurst,
    }
  }
  const mailgunApiKey = keys.MAILGUN_API_KEY.value.trim()
  const mailgunDomain = keys.MAILGUN_DOMAIN.value.trim()
  const smtp = buildSmtpConfig(
    keys.SMTP_HOST.value,
    keys.SMTP_PORT.value,
    keys.SMTP_USER.value,
    keys.SMTP_PASS.value,
  )

  return {
    provider,
    from,
    ...(mailgunApiKey !== '' ? { mailgunApiKey } : {}),
    ...(mailgunDomain !== '' ? { mailgunDomain } : {}),
    ...(smtp ? { smtp } : {}),
    keys,
  }
}

export type EmailSettingApiEntry = {
  value: string | null
  source: SettingSource
}

export function emailSettingsToApiShape(
  resolved: ResolvedEmailSettings,
): Record<string, EmailSettingApiEntry> {
  const out: Record<string, EmailSettingApiEntry> = {}

  for (const shortKey of EMAIL_SETTING_SHORT_KEYS) {
    const meta = resolved.keys[shortKey]
    const isSecret = EMAIL_SECRET_KEYS.has(shortKey)

    if (meta.source === 'env' && isSecret) {
      out[meta.fullKey] = { source: 'env', value: null }
      continue
    }

    if (meta.source === 'db' && isSecret) {
      out[meta.fullKey] = { source: 'db', value: '***' }
      continue
    }

    const value = meta.value.trim()
    out[meta.fullKey] = {
      source: meta.source,
      value: value === '' ? null : value,
    }
  }

  return out
}

export async function updateEmailSettings(
  db: Db,
  env: Record<string, string | undefined>,
  updates: Record<string, string | null>,
): Promise<ResolvedEmailSettings> {
  const resolver = await createEmailSettingsResolver(db, env)

  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue !== null && typeof rawValue !== 'string') continue

    const shortKey = resolveShortKeyFromInput(key)
    if (!shortKey) continue
    if (resolver.isEnvOverridden(shortKey)) continue

    if (rawValue === null) {
      await deleteEmailSetting(db, shortKey)
      continue
    }

    const trimmed = rawValue.trim()
    if (trimmed === '') continue

    if (shortKey === 'PROVIDER' && trimmed !== 'smtp' && trimmed !== 'mailgun') {
      continue
    }

    await upsertSettingValue(db, fullEmailSettingKey(shortKey), trimmed)
  }

  return await resolveEmailSettings(db, env)
}

async function deleteEmailSetting(db: Db, shortKey: EmailSettingShortKey): Promise<void> {
  await deleteSettingValue(db, fullEmailSettingKey(shortKey))
  const legacyKey = LEGACY_DB_KEYS[shortKey]
  if (legacyKey) {
    await deleteSettingValue(db, legacyKey)
  }
}

function resolveShortKeyFromInput(key: string): EmailSettingShortKey | null {
  const trimmed = key.trim()
  if (!trimmed) return null

  const prefix = `${EMAIL_SETTINGS_PREFIX}__`
  const upper = trimmed.toUpperCase()
  const shortKey = upper.startsWith(prefix) ? upper.slice(prefix.length) : upper

  if ((EMAIL_SETTING_SHORT_KEYS as readonly string[]).includes(shortKey)) {
    return shortKey as EmailSettingShortKey
  }
  return null
}
