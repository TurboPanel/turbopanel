/**
 * Delivery timing on a channel — digest cadence, quiet hours, the zone they
 * are read in — as the routes write and present it. The only place that knows
 * the zone of a personal channel is the owner's profile (`user.time_zone`).
 */
import type { Db } from '../../db/connection.ts'
import {
  channelTimeZones,
  type NotificationChannelRecord,
  setChannelHoldSettings,
  setUserTimeZone,
} from './records.ts'
import { type ChannelHoldFields, formatClockMinutes } from './windows.ts'

export type PresentedHold = {
  digestCadence: 'hourly' | 'daily' | null
  quietHours: { start: string; end: string } | null
  /** The zone quiet hours and digest windows are read in: owner profile, organization default, else UTC. */
  timeZone: string
}

export function presentHold(channel: NotificationChannelRecord, timeZone: string): PresentedHold {
  return {
    digestCadence: channel.digestCadence,
    quietHours: channel.quiet
      ? {
          start: formatClockMinutes(channel.quiet.startMinute),
          end: formatClockMinutes(channel.quiet.endMinute),
        }
      : null,
    timeZone,
  }
}

export async function presentChannelHold(
  db: Db,
  channel: NotificationChannelRecord
): Promise<PresentedHold> {
  const zones = await channelTimeZones(db, [channel])
  return presentHold(channel, zones.get(channel.id) ?? 'UTC')
}

/**
 * Apply the fields a body carried. Fields it left out keep their value; the
 * cadence and the quiet window are stored together, so both are re-written.
 * A zone is written to the owner's profile and only for their personal channel
 * (the route refuses it elsewhere).
 */
export async function applyHoldFields(
  db: Db,
  channel: NotificationChannelRecord,
  hold: ChannelHoldFields
): Promise<void> {
  if (hold.digestCadence !== undefined || hold.quiet !== undefined) {
    await setChannelHoldSettings(db, channel.id, {
      digestCadence: hold.digestCadence === undefined ? channel.digestCadence : hold.digestCadence,
      quiet: hold.quiet === undefined ? channel.quiet : hold.quiet,
    })
  }
  if (hold.timeZone !== undefined && channel.userId) {
    await setUserTimeZone(db, channel.userId, hold.timeZone)
  }
}
