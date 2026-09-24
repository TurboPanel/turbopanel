/**
 * Upgrade settings backed by the `setting` table.
 *
 * Mirrors the server-metrics setting shape: one jsonb row keyed by a stable
 * name, read fresh on every call so a panel change applies without a
 * redeploy. On Workers `autoUpdate` is always effectively true and the
 * stored flag is ignored by the orchestrator phase. This module only stores
 * and validates; it does not enforce that override.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'

export const UPGRADE_SETTINGS_KEY = 'UPGRADE_SETTINGS'

export const UPGRADE_BATCH_MODES = ['percent', 'count'] as const

export type UpgradeBatchMode = (typeof UPGRADE_BATCH_MODES)[number]

export type UpgradeSettings = {
  autoUpdate: boolean
  batch: { mode: UpgradeBatchMode; value: number }
  maintenanceWindow: {
    enabled: boolean
    /** Minutes after 00:00 UTC when the window opens (0–1439). */
    startMinute: number
    /** Window length in minutes (1–1440). */
    durationMinutes: number
    /**
     * UTC weekdays, 0 = Sunday through 6 = Saturday. Empty means every day.
     */
    weekdays: number[]
  }
}

export const DEFAULT_UPGRADE_SETTINGS: UpgradeSettings = {
  autoUpdate: false,
  batch: { mode: 'percent', value: 100 },
  maintenanceWindow: {
    enabled: false,
    startMinute: 0,
    durationMinutes: 60,
    weekdays: [],
  },
}

const PERCENT_MIN = 1
const PERCENT_MAX = 100
const COUNT_MIN = 1
const COUNT_MAX = 10_000
const START_MINUTE_MAX = 1439
const DURATION_MIN = 1
const DURATION_MAX = 1440
const WEEKDAY_MAX = 6

function nowTs(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(record)
  if (present.length !== keys.length) return false
  return keys.every((key) => Object.hasOwn(record, key))
}

function isBatchMode(value: unknown): value is UpgradeBatchMode {
  return value === 'percent' || value === 'count'
}

function isValidBatchValue(mode: UpgradeBatchMode, value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  if (mode === 'percent') return value >= PERCENT_MIN && value <= PERCENT_MAX
  return value >= COUNT_MIN && value <= COUNT_MAX
}

function isValidWeekdays(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  const seen = new Set<number>()
  for (const day of value) {
    if (!Number.isInteger(day) || day < 0 || day > WEEKDAY_MAX) return false
    if (seen.has(day)) return false
    seen.add(day)
  }
  return true
}

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= min && value <= max
}

function isValidMaintenanceWindow(
  value: unknown,
): value is UpgradeSettings['maintenanceWindow'] {
  if (!isRecord(value)) return false
  if (
    !hasExactKeys(value, [
      'enabled',
      'startMinute',
      'durationMinutes',
      'weekdays',
    ])
  ) {
    return false
  }
  if (typeof value.enabled !== 'boolean') return false
  if (!isIntegerInRange(value.startMinute, 0, START_MINUTE_MAX)) return false
  if (!isIntegerInRange(value.durationMinutes, DURATION_MIN, DURATION_MAX)) {
    return false
  }
  return isValidWeekdays(value.weekdays)
}

/** True when `value` is a complete upgrade-settings object. */
export function isValidUpgradeSettings(
  value: unknown,
): value is UpgradeSettings {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, ['autoUpdate', 'batch', 'maintenanceWindow'])) {
    return false
  }
  if (typeof value.autoUpdate !== 'boolean') return false
  if (!isRecord(value.batch) || !hasExactKeys(value.batch, ['mode', 'value'])) {
    return false
  }
  if (!isBatchMode(value.batch.mode)) return false
  if (!isValidBatchValue(value.batch.mode, value.batch.value)) return false
  return isValidMaintenanceWindow(value.maintenanceWindow)
}

function copySettings(settings: UpgradeSettings): UpgradeSettings {
  return {
    autoUpdate: settings.autoUpdate,
    batch: { mode: settings.batch.mode, value: settings.batch.value },
    maintenanceWindow: {
      enabled: settings.maintenanceWindow.enabled,
      startMinute: settings.maintenanceWindow.startMinute,
      durationMinutes: settings.maintenanceWindow.durationMinutes,
      weekdays: [...settings.maintenanceWindow.weekdays].sort((a, b) => a - b),
    },
  }
}

/**
 * Return a detached copy with weekdays sorted, or `null` when invalid.
 */
export function normalizeUpgradeSettings(
  value: unknown,
): UpgradeSettings | null {
  if (!isValidUpgradeSettings(value)) return null
  return copySettings(value)
}

/**
 * Read upgrade settings. An unset or invalid row falls back to
 * {@link DEFAULT_UPGRADE_SETTINGS}.
 */
export async function getUpgradeSettings(db: Db): Promise<UpgradeSettings> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, UPGRADE_SETTINGS_KEY))
    .limit(1)
  return normalizeUpgradeSettings(rows[0]?.value) ??
    copySettings(DEFAULT_UPGRADE_SETTINGS)
}

/**
 * Persist upgrade settings. Rejects a value {@link isValidUpgradeSettings}
 * does not accept.
 */
export async function setUpgradeSettings(
  db: Db,
  settings: UpgradeSettings,
): Promise<void> {
  const normalized = normalizeUpgradeSettings(settings)
  if (!normalized) {
    throw new TypeError('upgrade settings are invalid')
  }
  await db
    .insert(setting)
    .values({ key: UPGRADE_SETTINGS_KEY, value: normalized })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value: normalized,
        updatedAt: nowTs(),
      },
    })
}
