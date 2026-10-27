/**
 * The two `setting` rows behind always-on automatic updates.
 *
 * - `UPGRADE_PAUSE`: present while an administrator has paused all updates
 *   (Admin > Updates). It snapshots who paused and when, so the status read is
 *   one row with no join. Resume deletes it.
 * - `UPGRADE_CHECK`: this install's minute of the hour for the hourly check
 *   (drawn at random once, then stable) and when the last check ran.
 *
 * Both are single-row reads (`limit 1`). No schema change: the rows live in the
 * existing `setting` table, like `UPGRADE_SETTINGS`.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'
import { pickUpgradeCheckMinute, type UpgradeCheckSchedule } from '../upgrades/schedule.ts'

export const UPGRADE_PAUSE_KEY = 'UPGRADE_PAUSE'

export const UPGRADE_CHECK_KEY = 'UPGRADE_CHECK'

/** Who paused all updates, and when. */
export type UpgradePause = {
  since: string
  byUserId: string | null
  byEmail: string | null
  byName: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** A stored pause row, or null when the value is not one. */
export function parseUpgradePause(value: unknown): UpgradePause | null {
  if (!isRecord(value)) return null
  const since = stringOrNull(value.since)
  if (!since || !Number.isFinite(Date.parse(since))) return null
  return {
    since,
    byUserId: stringOrNull(value.byUserId),
    byEmail: stringOrNull(value.byEmail),
    byName: stringOrNull(value.byName),
  }
}

/** A stored check row, or null when the value is not one. */
export function parseUpgradeCheckSchedule(value: unknown): UpgradeCheckSchedule | null {
  if (!isRecord(value)) return null
  const minute = value.minute
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null
  }
  const createdAt = stringOrNull(value.createdAt)
  if (!createdAt) return null
  return { minute, createdAt, lastCheckAt: stringOrNull(value.lastCheckAt) }
}

async function readSettingValue(db: Db, key: string): Promise<unknown> {
  const rows = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, key))
    .limit(1)
  return rows[0]?.value
}

/** The pause in force, or null when updates run. */
export async function getUpgradePause(db: Db): Promise<UpgradePause | null> {
  return parseUpgradePause(await readSettingValue(db, UPGRADE_PAUSE_KEY))
}

/**
 * Pause all updates. A pause already in force is kept as it is (the first
 * pause's time and name stay). Returns the pause in force and whether this
 * call set it.
 */
export async function pauseUpgrades(
  db: Db,
  pause: UpgradePause
): Promise<{ pause: UpgradePause; changed: boolean }> {
  const inserted = await db
    .insert(setting)
    .values({ key: UPGRADE_PAUSE_KEY, value: pause })
    .onConflictDoNothing({ target: setting.key })
    .returning({ key: setting.key })
  if (inserted.length > 0) return { pause, changed: true }
  const current = await getUpgradePause(db)
  if (current) return { pause: current, changed: false }
  // An unreadable row: replace it so the pause is real.
  await db
    .update(setting)
    .set({ value: pause, updatedAt: new Date().toISOString() })
    .where(eq(setting.key, UPGRADE_PAUSE_KEY))
  return { pause, changed: true }
}

/** Resume updates. True when a pause was in force. */
export async function resumeUpgrades(db: Db): Promise<boolean> {
  const deleted = await db
    .delete(setting)
    .where(eq(setting.key, UPGRADE_PAUSE_KEY))
    .returning({ key: setting.key })
  return deleted.length > 0
}

/** The check row as stored, or null before the first maintenance tick wrote it. */
export async function readUpgradeCheckSchedule(db: Db): Promise<UpgradeCheckSchedule | null> {
  return parseUpgradeCheckSchedule(await readSettingValue(db, UPGRADE_CHECK_KEY))
}

/**
 * The check row, created on first use with a random minute. Concurrent first
 * uses race on the key; the loser reads the winner's minute.
 */
export async function ensureUpgradeCheckSchedule(
  db: Db,
  now: string,
  draw: () => number = Math.random
): Promise<UpgradeCheckSchedule> {
  const existing = await readUpgradeCheckSchedule(db)
  if (existing) return existing
  const fresh: UpgradeCheckSchedule = {
    minute: pickUpgradeCheckMinute(draw()),
    createdAt: now,
    lastCheckAt: null,
  }
  await db
    .insert(setting)
    .values({ key: UPGRADE_CHECK_KEY, value: fresh })
    .onConflictDoNothing({ target: setting.key })
  const stored = await readUpgradeCheckSchedule(db)
  if (stored) return stored
  // The row exists but is unreadable: replace it.
  await db
    .update(setting)
    .set({ value: fresh, updatedAt: now })
    .where(eq(setting.key, UPGRADE_CHECK_KEY))
  return fresh
}

/** Record that the hourly check ran at `at`, keeping the minute. */
export async function markUpgradeChecked(
  db: Db,
  schedule: UpgradeCheckSchedule,
  at: string
): Promise<void> {
  const next: UpgradeCheckSchedule = { ...schedule, lastCheckAt: at }
  await db
    .update(setting)
    .set({ value: next, updatedAt: at })
    .where(eq(setting.key, UPGRADE_CHECK_KEY))
}
