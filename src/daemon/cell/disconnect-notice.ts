/**
 * The `server.offline` notice for an ordinary disconnect.
 *
 * A socket that closes marks the server offline at once but says nothing: a
 * daemon restart, an update or a network blip would page people for a server
 * that is back in seconds. This pass raises the notice once the server has
 * stayed away for the grace period, one time per outage (the claim marker in
 * `server.daemon.projection`, set by the same statement that selects the row,
 * is cleared by the reconnect). A stale-sweep demotion is announced by the sweep
 * itself and is never claimed here.
 *
 * No timer and no alarm of its own: it rides the tick each runtime already runs
 * (the Workers cron, the Deno liveness timer) and adds one indexed Postgres
 * statement to it, so a Durable Object stays asleep. There is no matching
 * "back online" notice: the catalogue has no such event.
 */
import type { Db } from '../../db/connection.ts'
import type { AlertSender } from '../../features/alerts/alert-sender.ts'
import {
  ALERT_DELIVERY_BUDGET_MS,
  notifyDemotions,
} from '../../features/alerts/notify-demotions.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { isMassDisconnect } from './mass-disconnect.ts'
import { claimDisconnectNotices, countConnectedServers } from './postgres-projection.ts'

/** How far back an unannounced outage is still worth announcing. */
export const DISCONNECT_NOTICE_WINDOW_MS = 30 * 60_000

export type DisconnectNoticeOptions = {
  /** How long a server must stay away before it is announced. */
  graceMs: number
  nowMs?: number
  /**
   * Resolved only when something was claimed: the common tick claims nothing
   * and should not cost a settings read.
   */
  resolveSender: () => Promise<AlertSender>
  /** Wait for delivery (Workers cron, bounded by the tick) or hand it off (Deno liveness lane). */
  awaitDelivery: boolean
  budgetMs?: number
  windowMs?: number
  claim?: typeof claimDisconnectNotices
  countConnected?: typeof countConnectedServers
}

/** Claim and announce due outages; returns how many were claimed. */
export async function noticeDisconnectedServers(
  db: Db,
  opts: DisconnectNoticeOptions
): Promise<number> {
  // Never claim what there is no time left to announce: a claim is at-most-once.
  if (opts.budgetMs !== undefined && opts.budgetMs <= 0) return 0
  const claim = opts.claim ?? claimDisconnectNotices
  const ids = await claim(db, {
    nowMs: opts.nowMs ?? Date.now(),
    graceMs: opts.graceMs,
    windowMs: opts.windowMs ?? DISCONNECT_NOTICE_WINDOW_MS,
  })
  if (ids.length === 0) return 0

  const deliver = async (): Promise<void> => {
    const sender = await opts.resolveSender()
    let massDisconnect = null
    if (isMassDisconnect(ids.length, ids.length)) {
      // The same rule as the stale sweep: the aggregate explains the lines.
      try {
        const connectedNow = await (opts.countConnected ?? countConnectedServers)(db)
        const connectedBefore = connectedNow + ids.length
        if (isMassDisconnect(ids.length, connectedBefore)) {
          massDisconnect = { staleCount: ids.length, connectedBefore }
        }
      } catch {
        // No denominator: the per-server lines still go out, without the aggregate.
      }
    }
    await notifyDemotions(ids, massDisconnect, sender, opts.budgetMs ?? ALERT_DELIVERY_BUDGET_MS)
  }
  if (opts.awaitDelivery) await deliver()
  else {
    void deliver().catch((err: unknown) => {
      compatLogWarn(
        'daemon-cell',
        `disconnect notice delivery failed: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    })
  }
  return ids.length
}
