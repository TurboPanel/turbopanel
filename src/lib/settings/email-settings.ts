import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'
import type { SmtpConfig } from '../email/smtp/smtp-resolve.ts'
import {
  normalizeSettingFullKey,
  SettingsResolver,
  type ResolvedSetting,
  type SettingSource,
} from './resolver.ts'

const SYSTEM_EMAIL_DB_KEY = 'SYSTEM_EMAIL'

export const EMAIL_SETTINGS_PREFIX = 'TURBOPANEL_SYSTEM_EMAIL'

export const EMAIL_SETTING_SHORT_KEYS = [
  'PROVIDER',
  'FROM',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN',
  'MAILGUN_REGION',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'RATE_LIMIT_PER_MINUTE',
  'RATE_LIMIT_BURST',
  'QUEUE_PREFETCH',
] as const

export type EmailSettingShortKey = (typeof EMAIL_SETTING_SHORT_KEYS)[number]

export type EmailProvider = 'smtp' | 'mailgun' | 'mailpit'

export const EMAIL_SETTINGS_SCHEMA: Record<EmailSettingShortKey, string | undefined> = {
  PROVIDER: 'smtp',
  FROM: 'noreply@turbopanel.local',
  MAILGUN_API_KEY: undefined,
  MAILGUN_DOMAIN: undefined,
  MAILGUN_REGION: 'us',
  SMTP_HOST: undefined,
  SMTP_PORT: undefined,
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
  RATE_LIMIT_PER_MINUTE: '60',
  RATE_LIMIT_BURST: undefined,
  QUEUE_PREFETCH: '1',
}

export const EMAIL_SECRET_KEYS: ReadonlySet<EmailSettingShortKey> = new Set([
  'MAILGUN_API_KEY',
  'SMTP_PASS',
])

export type EmailSettingMeta = {
  fullKey: string
  value: string
  source: SettingSource
  isEnvOverridden: boolean
  isDbSet: boolean
}

export type MailgunRegion = 'us' | 'eu'

export type ResolvedEmailSettings = {
  provider: EmailProvider
  from: string
  mailgunApiKey?: string
  mailgunDomain?: string
  mailgunRegion: MailgunRegion
  mailgunApiBase: string
  smtp?: SmtpConfig
  keys: Record<EmailSettingShortKey, EmailSettingMeta>
}

/** True when email is configured and usable for outbound delivery. */
export function isEmailActive(settings: ResolvedEmailSettings): boolean {
  if (settings.provider === 'mailpit') return true
  if (settings.provider === 'smtp') return settings.smtp !== undefined
  if (settings.provider === 'mailgun') {
    const apiKey = settings.mailgunApiKey?.trim() ?? ''
    const domain = settings.mailgunDomain?.trim() ?? ''
    return apiKey !== '' && domain !== ''
  }
  return false
}

/** Apply runtime-specific provider normalization before activation checks. */
export function normalizeEmailSettingsForRuntime(
  settings: ResolvedEmailSettings,
  _runtime: 'deno' | 'workers',
): ResolvedEmailSettings {
  return settings
}

/** Settings-based signup verification gate. */
export function isEmailActiveForRuntime(
  settings: ResolvedEmailSettings,
  runtime: 'deno' | 'workers',
): boolean {
  return isEmailActive(normalizeEmailSettingsForRuntime(settings, runtime))
}

export function resolveMailgunApiBase(region: string | undefined): string {
  const normalized = region?.trim().toLowerCase()
  if (normalized === 'eu') return 'https://api.eu.mailgun.net/v3'
  return 'https://api.mailgun.net/v3'
}

function parseMailgunRegion(value: string): MailgunRegion {
  return value.trim().toLowerCase() === 'eu' ? 'eu' : 'us'
}

function fullEmailSettingKey(shortKey: EmailSettingShortKey): string {
  return normalizeSettingFullKey(EMAIL_SETTINGS_PREFIX, shortKey)
}

function parseProvider(value: string): EmailProvider {
  if (value === 'mailgun') return 'mailgun'
  if (value === 'mailpit') return 'mailpit'
  return 'smtp'
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

function readSystemEmailObject(value: unknown): Record<string, string> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[key] = raw
    } else if (
      typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint'
    ) {
      out[key] = `${raw}`
    } else if (raw != null) {
      out[key] = JSON.stringify(raw)
    }
  }
  return out
}

async function loadSystemEmailObject(db: Db): Promise<Record<string, string>> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, SYSTEM_EMAIL_DB_KEY))
    .limit(1)

  return readSystemEmailObject(rows[0]?.value)
}

type EmailSettingMutation = {
  shortKey: EmailSettingShortKey
  value: string | null
}

function isAllowedEmailSettingValue(
  shortKey: EmailSettingShortKey,
  trimmed: string,
): boolean {
  if (shortKey === 'PROVIDER') {
    return trimmed === 'smtp' || trimmed === 'mailgun' || trimmed === 'mailpit'
  }
  if (shortKey === 'MAILGUN_REGION') {
    return trimmed === 'us' || trimmed === 'eu'
  }
  return true
}

function collectEmailSettingMutations(
  resolver: SettingsResolver,
  updates: Record<string, string | null>,
): EmailSettingMutation[] {
  const mutations: EmailSettingMutation[] = []

  for (const [key, rawValue] of Object.entries(updates)) {
    if (rawValue !== null && typeof rawValue !== 'string') continue

    const shortKey = resolveShortKeyFromInput(key)
    if (!shortKey) continue
    if (resolver.isEnvOverridden(shortKey)) continue

    if (rawValue === null) {
      mutations.push({ shortKey, value: null })
      continue
    }

    const trimmed = rawValue.trim()
    if (trimmed === '') continue
    if (!isAllowedEmailSettingValue(shortKey, trimmed)) continue

    mutations.push({ shortKey, value: trimmed })
  }

  return mutations
}

async function applyEmailSettingMutations(
  db: Db,
  mutations: EmailSettingMutation[],
): Promise<void> {
  if (mutations.length === 0) return

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, SYSTEM_EMAIL_DB_KEY))
      .for('update')
      .limit(1)

    const obj = readSystemEmailObject(rows[0]?.value)

    for (const { shortKey, value } of mutations) {
      if (value === null) {
        delete obj[shortKey]
      } else {
        obj[shortKey] = value
      }
    }

    if (Object.keys(obj).length === 0) {
      await tx.delete(setting).where(eq(setting.key, SYSTEM_EMAIL_DB_KEY))
      return
    }

    await tx
      .insert(setting)
      .values({ key: SYSTEM_EMAIL_DB_KEY, value: obj })
      .onConflictDoUpdate({
        target: setting.key,
        set: {
          value: obj,
          updatedAt: new Date().toISOString(),
        },
      })
  })
}

async function loadEmailSettingDbValues(db: Db): Promise<Map<string, string>> {
  const obj = await loadSystemEmailObject(db)
  const out = new Map<string, string>()

  for (const shortKey of EMAIL_SETTING_SHORT_KEYS) {
    const stored = obj[shortKey]
    if (stored !== undefined && stored !== '') {
      out.set(fullEmailSettingKey(shortKey), stored)
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
  const mailgunRegion = parseMailgunRegion(
    keys.MAILGUN_REGION.value.trim() || EMAIL_SETTINGS_SCHEMA.MAILGUN_REGION!,
  )
  const mailgunApiBase = resolveMailgunApiBase(mailgunRegion)
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
    mailgunRegion,
    mailgunApiBase,
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
  const mutations = collectEmailSettingMutations(resolver, updates)
  await applyEmailSettingMutations(db, mutations)
  return await resolveEmailSettings(db, env)
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
