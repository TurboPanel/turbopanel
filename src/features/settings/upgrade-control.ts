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
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'
import { pickUpgradeCheckMinute, type UpgradeCheckSchedule } from '../upgrades/schedule.ts'

export const UPGRADE_PAUSE_KEY = 'UPGRADE_PAUSE'

export const UPGRADE_CHECK_KEY = 'UPGRADE_CHECK'

/**
 * The web interface build this self-hosted control plane serves. The control
 * plane cannot read the installed bundle itself: a finished control-plane
 * install records its run's UI target (`install`), and before any install the
 * console's own report of the bundle it was served stands in (`console`). An
 * install record is never replaced by a console report, so a stale browser tab
 * cannot reopen a UI install.
 */
export const UPGRADE_UI_INSTALLED_KEY = 'UPGRADE_UI_INSTALLED'

export type InstalledUiRecord = {
  commit: string
  source: 'install' | 'console'
  at: string
}

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
  return {
    minute,
    createdAt,
    lastCheckAt: stringOrNull(value.lastCheckAt),
    lastManualCheckAt: stringOrNull(value.lastManualCheckAt),
  }
}

/** A stored installed-UI row, or null when the value is not one. */
export function parseInstalledUi(value: unknown): InstalledUiRecord | null {
  if (!isRecord(value)) return null
  const commit = stringOrNull(value.commit)
  const at = stringOrNull(value.at)
  const source = value.source
  if (!commit || !at || (source !== 'install' && source !== 'console')) return null
  return { commit, source, at }
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

/**
 * Record a Check Now press at `at` if the last one was at least `gapMs` ago.
 * One conditional statement on the one field, so two presses (or a press and
 * the scheduled check) never overwrite each other. False when too soon.
 */
export async function claimManualUpgradeCheck(db: Db, at: string, gapMs: number): Promise<boolean> {
  const rows = await db
    .update(setting)
    .set({
      value: sql`jsonb_set(${setting.value}, '{lastManualCheckAt}', to_jsonb(${at}::text))`,
      updatedAt: at,
    })
    .where(
      and(
        eq(setting.key, UPGRADE_CHECK_KEY),
        sql`(${setting.value}->>'lastManualCheckAt' is null or (${setting.value}->>'lastManualCheckAt')::timestamptz <= ${at}::timestamptz - make_interval(secs => ${gapMs / 1000}))`
      )
    )
    .returning({ key: setting.key })
  return rows.length > 0
}

/** Record that the scheduled check ran at `at`; only that field is written. */
export async function markUpgradeChecked(db: Db, at: string): Promise<void> {
  await db
    .update(setting)
    .set({
      value: sql`jsonb_set(${setting.value}, '{lastCheckAt}', to_jsonb(${at}::text))`,
      updatedAt: at,
    })
    .where(eq(setting.key, UPGRADE_CHECK_KEY))
}

/** The installed web interface build, or null when nothing recorded it yet. */
export async function getInstalledUi(db: Db): Promise<InstalledUiRecord | null> {
  return parseInstalledUi(await readSettingValue(db, UPGRADE_UI_INSTALLED_KEY))
}

/**
 * Record the installed web interface build. An `install` record always wins;
 * a `console` report is written only while no install has been recorded and
 * only when it names a different build.
 */
export async function recordInstalledUi(db: Db, record: InstalledUiRecord): Promise<void> {
  const insert = db.insert(setting).values({ key: UPGRADE_UI_INSTALLED_KEY, value: record })
  if (record.source === 'install') {
    await insert.onConflictDoUpdate({
      target: setting.key,
      set: { value: record, updatedAt: record.at },
    })
    return
  }
  await insert.onConflictDoUpdate({
    target: setting.key,
    set: { value: record, updatedAt: record.at },
    setWhere: sql`${setting.value}->>'source' = 'console' and ${setting.value}->>'commit' is distinct from ${record.commit}`,
  })
}
