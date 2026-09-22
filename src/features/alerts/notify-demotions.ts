/**
 * Deliver one sweep's alerts, bounded, after its demotions have landed.
 *
 * Shared by both sweeps (the Workers cron and the self-hosted Deno/Redis
 * timer) because both have the same invariant to protect: **alerting must
 * never delay or displace the demotions it reports on.** That is not a
 * stylistic preference — a webhook awaited inside a demotion fan-out spends
 * the tick budget, and a tick that runs out of budget leaves dead hosts
 * marked online, which is the outage alerting exists to catch.
 *
 * Two bounds, and it is worth being precise about which does what:
 *
 * - **Per delivery**, the sender's own contract (`alert-sender.ts`): awaiting
 *   it terminates, because the webhook sender carries an AbortSignal.
 * - **Per batch**, the budget here: a sender that violates its contract, or
 *   twenty hosts × a slow-but-legal webhook, cannot hold a tick open past
 *   `budgetMs`. Alerts that do not fit are dropped, with a trace saying so.
 *
 * Callers that must not block at all — the Deno liveness lane, whose whole
 * purpose is that a hung webhook cannot suppress the next stale-presence
 * tick — should `void` this rather than await it. The batch bound is then
 * what keeps a pathological sender from accumulating across ticks.
 */
import type { AlertSender } from './alert-sender.ts'
import { massDisconnectText, serverOfflineText } from './offline-copy.ts'

/** Ceiling on what one sweep will spend telling an operator what it did. */
export const ALERT_DELIVERY_BUDGET_MS = 5_000

export type DemotionAlertTrace = (
  event: 'alerts-skipped' | 'alerts-truncated' | 'alerts-deadline-reached',
  detail: Record<string, unknown>,
) => void

export type MassDisconnectFacts = {
  staleCount: number
  connectedBefore: number
}

export async function notifyDemotions(
  demoted: readonly string[],
  massDisconnect: MassDisconnectFacts | null,
  alertSender: AlertSender,
  budgetMs: number = ALERT_DELIVERY_BUDGET_MS,
  trace?: DemotionAlertTrace,
): Promise<void> {
  if (!massDisconnect && demoted.length === 0) return
  if (budgetMs <= 0) {
    trace?.('alerts-skipped', { count: demoted.length })
    return
  }

  const deadlineMs = Date.now() + budgetMs

  // The aggregate goes first: it is what explains the per-server lines.
  const deliver = async (): Promise<void> => {
    if (massDisconnect) {
      await alertSender({
        kind: 'fleet.mass_disconnect',
        text: massDisconnectText(
          massDisconnect.staleCount,
          massDisconnect.connectedBefore,
        ),
        detail: massDisconnect,
      })
    }
    for (let i = 0; i < demoted.length; i++) {
      if (Date.now() >= deadlineMs) {
        trace?.('alerts-truncated', { remaining: demoted.length - i })
        return
      }
      await alertSender({
        kind: 'server.offline',
        text: serverOfflineText(demoted[i]),
        detail: { serverId: demoted[i] },
      })
    }
  }

  // A plain one-shot `setTimeout(resolve, …)` sleep and nothing else:
  // `scripts/check-durable-object-hibernation.mjs` forbids every other shape
  // in the cell directory this is called from, because a timer that re-arms
  // keeps the Durable Object awake. Cleared as soon as the race settles.
  let timer: ReturnType<typeof setTimeout> | undefined
  let delivered = false
  await Promise.race([
    deliver().then(() => {
      delivered = true
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  if (!delivered) trace?.('alerts-deadline-reached', {})
}
