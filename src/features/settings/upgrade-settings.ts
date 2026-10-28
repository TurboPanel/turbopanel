/**
 * Upgrade settings backed by the `setting` table.
 *
 * Mirrors the server-metrics setting shape: one jsonb row keyed by a stable
 * name, read fresh on every call so a panel change applies without a
 * redeploy. Updates are always automatic, so the only stored choice is how many
 * servers update at once (`batch`). Rows written before that change also carry
 * `autoUpdate` and `maintenanceWindow`; they are read and ignored, never
 * rejected, so a saved batch survives the upgrade. This module only stores and
 * validates.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'

export const UPGRADE_SETTINGS_KEY = 'UPGRADE_SETTINGS'

export const UPGRADE_BATCH_MODES = ['percent', 'count'] as const

export type UpgradeBatchMode = (typeof UPGRADE_BATCH_MODES)[number]

export type UpgradeSettings = {
  batch: { mode: UpgradeBatchMode; value: number }
}

/**
 * Every server in one wave unless an administrator saves a smaller batch in
 * Admin > Updates (or the environment sets `TURBOPANEL_UPGRADE_BATCH`).
 */
export const DEFAULT_UPGRADE_BATCH: UpgradeSettings['batch'] = {
  mode: 'percent',
  value: 100,
}

export const DEFAULT_UPGRADE_SETTINGS: UpgradeSettings = {
  batch: { ...DEFAULT_UPGRADE_BATCH },
}

/**
 * Keys an older row (or an older console's save) may still carry. They are
 * accepted and dropped; nothing reads them any more.
 */
const LEGACY_KEYS = ['autoUpdate', 'maintenanceWindow'] as const

/**
 * What a save writes beside `batch`, so a control plane rolled back to a build
 * that still reads these keys sees a valid row with automatic updates on and
 * no window.
 */
const LEGACY_COMPAT_FIELDS = {
  autoUpdate: true,
  maintenanceWindow: { enabled: false, startMinute: 0, durationMinutes: 60, weekdays: [] },
}

const PERCENT_MIN = 1
const PERCENT_MAX = 100
const COUNT_MIN = 1
const COUNT_MAX = 10_000

function nowTs(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
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

/**
 * Parse `TURBOPANEL_UPGRADE_BATCH` (`count:5` or `percent:25`). Blank or
 * anything outside the stored limits falls back to {@link DEFAULT_UPGRADE_BATCH}.
 */
export function parseUpgradeBatchDefault(raw: string | undefined): UpgradeSettings['batch'] {
  const match = /^(percent|count):(\d{1,5})$/.exec(raw?.trim() ?? '')
  if (!match) return { ...DEFAULT_UPGRADE_BATCH }
  const mode = match[1] as UpgradeBatchMode
  const value = Number.parseInt(match[2], 10)
  return isValidBatchValue(mode, value) ? { mode, value } : { ...DEFAULT_UPGRADE_BATCH }
}

/**
 * True when `value` names a valid `batch`. Legacy keys (`autoUpdate`,
 * `maintenanceWindow`) may be present and are ignored; any other key is not.
 */
export function isValidUpgradeSettings(value: unknown): value is UpgradeSettings {
  if (!isRecord(value)) return false
  const allowed = new Set<string>(['batch', ...LEGACY_KEYS])
  if (!Object.keys(value).every((key) => allowed.has(key))) return false
  if (!isRecord(value.batch) || !hasExactKeys(value.batch, ['mode', 'value'])) {
    return false
  }
  if (!isBatchMode(value.batch.mode)) return false
  return isValidBatchValue(value.batch.mode, value.batch.value)
}

function copySettings(settings: UpgradeSettings): UpgradeSettings {
  return { batch: { mode: settings.batch.mode, value: settings.batch.value } }
}

/**
 * Return a detached copy holding only `batch`, or `null` when invalid.
 */
export function normalizeUpgradeSettings(value: unknown): UpgradeSettings | null {
  if (!isValidUpgradeSettings(value)) return null
  return copySettings(value)
}

/**
 * Read upgrade settings. An unset or invalid row falls back to
 * {@link DEFAULT_UPGRADE_SETTINGS}, with `defaultBatch` (this environment's
 * starting batch) in place of the built-in one.
 */
export async function getUpgradeSettings(
  db: Db,
  defaultBatch: UpgradeSettings['batch'] = DEFAULT_UPGRADE_BATCH
): Promise<UpgradeSettings> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, UPGRADE_SETTINGS_KEY))
    .limit(1)
  return normalizeUpgradeSettings(rows[0]?.value) ?? copySettings({ batch: defaultBatch })
}

/**
 * Persist upgrade settings. Rejects a value {@link isValidUpgradeSettings}
 * does not accept.
 */
export async function setUpgradeSettings(db: Db, settings: UpgradeSettings): Promise<void> {
  const normalized = normalizeUpgradeSettings(settings)
  if (!normalized) {
    throw new TypeError('upgrade settings are invalid')
  }
  const stored = { ...LEGACY_COMPAT_FIELDS, ...normalized }
  await db
    .insert(setting)
    .values({ key: UPGRADE_SETTINGS_KEY, value: stored })
    .onConflictDoUpdate({
      target: setting.key,
      set: {
        value: stored,
        updatedAt: nowTs(),
      },
    })
}
