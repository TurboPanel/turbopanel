import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { setting } from '../db/schema.ts'

export function normalizeSettingPrefix(prefix: string): string {
  return prefix.trim().toUpperCase()
}

export function normalizeSettingShortKey(shortKey: string): string {
  return shortKey.trim().toUpperCase()
}

export function normalizeSettingFullKey(prefix: string, shortKey: string): string {
  return `${normalizeSettingPrefix(prefix)}__${normalizeSettingShortKey(shortKey)}`
}

function normalizeFullKey(key: string): string {
  return key.trim().toUpperCase()
}

export type SettingSource = 'env' | 'db' | 'default'

/** JSON-compatible values stored in `setting.value` (jsonb). */
export type SettingValue =
  | string
  | number
  | boolean
  | null
  | SettingValue[]
  | { [key: string]: SettingValue }

export type ResolvedSetting = {
  value: string
  source: SettingSource
}

export type SettingsSchema = Record<string, string | undefined>

export type EnvAliases = Record<string, readonly string[]>

function coerceSettingValueToString(value: SettingValue): string {
  if (typeof value === 'string') return value
  if (value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export class SettingsResolver {
  private readonly prefix: string
  private readonly keys: SettingsSchema
  private readonly env: Record<string, string | undefined>
  private readonly dbValues: Map<string, SettingValue>
  private readonly envAliases: EnvAliases

  constructor(opts: {
    prefix: string
    keys: SettingsSchema
    env: Record<string, string | undefined>
    dbValues: Map<string, SettingValue>
    envAliases?: EnvAliases
  }) {
    this.prefix = normalizeSettingPrefix(opts.prefix)
    this.keys = opts.keys
    this.env = opts.env
    this.dbValues = opts.dbValues
    this.envAliases = opts.envAliases ?? {}
  }

  fullKey(shortKey: string): string {
    return normalizeSettingFullKey(this.prefix, shortKey)
  }

  resolve(shortKey: string): ResolvedSetting {
    const normalizedShortKey = normalizeSettingShortKey(shortKey)
    const envValue = this.envValue(normalizedShortKey)
    if (envValue !== undefined) {
      return { value: envValue, source: 'env' }
    }

    const fullKey = this.fullKey(normalizedShortKey)
    const rawDbValue = this.dbValues.get(fullKey)
    const dbValue = rawDbValue !== undefined
      ? coerceSettingValueToString(rawDbValue).trim()
      : undefined
    if (dbValue !== undefined && dbValue !== '') {
      return { value: dbValue, source: 'db' }
    }

    const defaultValue = this.keys[normalizedShortKey]?.trim() ?? ''
    return { value: defaultValue, source: 'default' }
  }

  isEnvOverridden(shortKey: string): boolean {
    return this.envValue(normalizeSettingShortKey(shortKey)) !== undefined
  }

  isDbSet(shortKey: string): boolean {
    const fullKey = this.fullKey(shortKey)
    const rawDbValue = this.dbValues.get(fullKey)
    const dbValue = rawDbValue !== undefined
      ? coerceSettingValueToString(rawDbValue).trim()
      : undefined
    return dbValue !== undefined && dbValue !== ''
  }

  private envValue(normalizedShortKey: string): string | undefined {
    const fullKey = this.fullKey(normalizedShortKey)
    const primary = this.env[fullKey]?.trim()
    if (primary !== undefined && primary !== '') return primary

    const aliases = this.envAliases[normalizedShortKey]
    if (!aliases) return undefined

    for (const alias of aliases) {
      const value = this.env[alias]?.trim()
      if (value !== undefined && value !== '') return value
    }
    return undefined
  }
}

export async function loadSettingValues(
  db: Db,
  fullKeys: string[],
): Promise<Map<string, SettingValue>> {
  if (fullKeys.length === 0) return new Map()

  const normalizedKeys = fullKeys.map((key) => normalizeFullKey(key))
  const rows = await db
    .select()
    .from(setting)
    .where(inArray(setting.key, normalizedKeys))

  return new Map(
    rows.map((row) => [
      normalizeFullKey(row.key),
      row.value as SettingValue,
    ]),
  )
}

export async function upsertSettingValue(
  db: Db,
  key: string,
  value: SettingValue,
): Promise<void> {
  const normalizedKey = normalizeFullKey(key)
  await db
    .insert(setting)
    .values({ key: normalizedKey, value })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value,
        updatedAt: new Date().toISOString(),
      },
    })
}

export async function deleteSettingValue(db: Db, key: string): Promise<void> {
  await db.delete(setting).where(eq(setting.key, normalizeFullKey(key)))
}

export async function createSettingsResolver(
  db: Db,
  opts: {
    prefix: string
    keys: SettingsSchema
    env: Record<string, string | undefined>
    envAliases?: EnvAliases
  },
): Promise<SettingsResolver> {
  const prefix = normalizeSettingPrefix(opts.prefix)
  const fullKeys = Object.keys(opts.keys).map((shortKey) =>
    normalizeSettingFullKey(prefix, shortKey)
  )
  const dbValues = await loadSettingValues(db, fullKeys)
  return new SettingsResolver({
    prefix,
    keys: opts.keys,
    env: opts.env,
    dbValues,
    envAliases: opts.envAliases,
  })
}
