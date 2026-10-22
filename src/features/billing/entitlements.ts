/**
 * Entitlement sync: committed seats in, the coverage report out.
 *
 * Runs after every successful projection (the webhook task) and at the
 * end of every mutation route, so the webhook is a redundant idempotent
 * confirmation rather than the only path. Under the organization's
 * quantity lease it:
 *
 *   1. reads the pending-change ledger and drops the intents whose change
 *      the committed items now show (`landedIntents`);
 *   2. reads the managers' assignment against the new seats
 *      (`peekOrganizationAssignment`) and reports servers left uncovered —
 *      it never writes `server.assigned_tier_id`;
 *   3. on an **ended** subscription, revokes every license the
 *      organization holds — bound ones included — and clears the ledger;
 *   4. rebuilds the deferred schedule when the ledger still carries
 *      intents but the subscription has no schedule (an immediate change
 *      released it and was parked as pending).
 *
 * Nothing here assigns, moves or releases a server's license tier: only
 * the organization's managers do that. A seat change that leaves a server
 * holding a tier nobody pays for is reported as uncovered; the server keeps
 * its tier and stays connected, and the console shows why.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { Db } from '../../db/connection.ts'
import { logInfo, logWarn } from '../../lib/logger.ts'
import {
  isEndedStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
  revokeAllLicensesForOrganization,
} from './billing-records.ts'
import { peekOrganizationAssignment } from '../tiers/assignment-records.ts'
import type { TierAssignment } from '../tiers/assignment.ts'
import type { StripeClient } from './client.ts'
import { resolveBillingGateway } from './gateway.ts'
import {
  deferredDeltasByTier,
  landedIntents,
  type PendingChangeLedger,
  readPendingChanges,
  withoutIntents,
  writePendingChanges,
} from './pending-changes.ts'
import {
  type BillingQuantityLock,
  endQuantityMutation,
  tryBeginQuantityMutation,
} from './quantity-lock.ts'
import { syncDeferredSchedule } from './schedules.ts'
import type { SeatLine } from './subscriptions.ts'
import { priceMapWithIntentTargets } from './tier-prices.ts'

export type EntitlementSyncDeps = Readonly<{
  db: Db
  /** Needed only to rebuild a released schedule; `null` skips that step. */
  client: StripeClient | null
  logScope?: string
  nowMs?: number
  onRevokeBound?: (serverId: string) => Promise<void>
  /** How long to wait for a held lease before skipping. */
  leaseRetry?: Readonly<{ attempts: number; delayMs: number }>
}>

/**
 * A route holds the lease for one Stripe round trip; a webhook landing
 * meanwhile waits a few seconds rather than skipping.
 */
export const DEFAULT_LEASE_RETRY = { attempts: 4, delayMs: 1500 } as const

async function acquireLeaseWithRetry(
  db: Db,
  organizationId: string,
  nowMs: number,
  retry: Readonly<{ attempts: number; delayMs: number }>
): Promise<BillingQuantityLock | null> {
  const attempts = Math.max(1, retry.attempts)
  const tryFrom = async (attempt: number): Promise<BillingQuantityLock | null> => {
    if (attempt >= attempts) return null
    const lock = await tryBeginQuantityMutation(db, organizationId, nowMs + attempt * retry.delayMs)
    if (lock) return lock
    if (attempt + 1 < retry.attempts) {
      await new Promise((resolve) => setTimeout(resolve, retry.delayMs))
    }
    return await tryFrom(attempt + 1)
  }
  return await tryFrom(0)
}

export type EntitlementSyncInput = Readonly<{
  organizationId: string
  providerSubscriptionId: string
  /** The refetched subscription carries a `pending_update`: no schedule rebuild while it stands. */
  pendingUpdate: boolean
  /** A lease the caller already holds; otherwise one is taken here. */
  lock?: BillingQuantityLock
  /** Already-loaded state, to skip the second read. */
  state?: OrganizationBillingState
}>

export type EntitlementSyncResult = Readonly<{
  landedIntentIds: string[]
  /** The managers' assignment read against the seats; this sync never changes it. */
  assignment: TierAssignment
  revokedLicenseIds: string[]
  /** Servers whose bound license was revoked (subscription ended only). */
  disconnectedServerIds: string[]
}>

export type EntitlementSyncOutcome =
  | { action: 'synced'; result: EntitlementSyncResult; scheduleRebuilt: boolean }
  | { action: 'skipped'; reason: 'lease_held' }

/** Seat lines and the two price maps the schedule needs, from projected state. */
export function seatLinesFromState(state: OrganizationBillingState): {
  lines: SeatLine[]
  priceByTier: Map<string, string>
  tierByPrice: Map<string, string>
} {
  const lines: SeatLine[] = []
  const priceByTier = new Map<string, string>()
  const tierByPrice = new Map<string, string>()
  for (const seat of state.seats) {
    if (!seat.providerPriceId) continue
    lines.push({
      providerItemId: seat.providerItemId,
      providerPriceId: seat.providerPriceId,
      tierId: seat.tierId,
      quantity: seat.quantity,
    })
    priceByTier.set(seat.tierId, seat.providerPriceId)
    tierByPrice.set(seat.providerPriceId, seat.tierId)
  }
  return { lines, priceByTier, tierByPrice }
}

/** An ended subscription has nothing left to defer. */
function clearLedgerIfSubscriptionEnded(
  ledger: PendingChangeLedger,
  state: OrganizationBillingState
): PendingChangeLedger {
  if (!state.subscription || !isEndedStatus(state.subscription.status)) return ledger
  return { ...ledger, intents: [] }
}

async function rebuildDeferredScheduleIfNeeded(
  deps: EntitlementSyncDeps,
  input: EntitlementSyncInput,
  state: OrganizationBillingState,
  ledger: PendingChangeLedger,
  logScope: string
): Promise<boolean> {
  const deltas = deferredDeltasByTier(ledger)
  const needsSchedule = [...deltas.values()].some((delta) => delta !== 0)
  const subscription = state.subscription
  if (
    !deps.client ||
    !needsSchedule ||
    input.pendingUpdate ||
    !subscription ||
    subscription.scheduleId ||
    isEndedStatus(subscription.status)
  ) {
    return false
  }
  const { lines, priceByTier } = seatLinesFromState(state)
  try {
    await syncDeferredSchedule(deps.client, {
      providerSubscriptionId: input.providerSubscriptionId,
      scheduleId: null,
      current: lines,
      deltasByTier: deltas,
      priceByTier: await priceMapWithIntentTargets(
        deps.db,
        resolveBillingGateway(deps.client),
        priceByTier,
        ledger
      ),
      // Keyed on the newest intent: fixed length (Stripe caps keys at 255).
      idempotencyKey: `${ledger.intents.at(-1)!.idempotencyKey}:rebuild`,
    })
    return true
  } catch (err) {
    // The intents survive in the ledger; the next mutation or sync retries.
    logWarn(
      logScope,
      `organization ${input.organizationId}: schedule rebuild failed: ${String(err)}`
    )
    return false
  }
}

function seatsAtFromState(state: OrganizationBillingState): (tierId: string) => number {
  const ended = !state.subscription || isEndedStatus(state.subscription.status)
  const totals = new Map<string, number>()
  for (const seat of state.seats) {
    totals.set(seat.tierId, ended ? 0 : (totals.get(seat.tierId) ?? 0) + seat.quantity)
  }
  return (tierId) => totals.get(tierId) ?? 0
}

export async function syncEntitlementsForOrganization(
  deps: EntitlementSyncDeps,
  input: EntitlementSyncInput
): Promise<EntitlementSyncOutcome> {
  const logScope = deps.logScope ?? 'billing-entitlements'
  const nowMs = deps.nowMs ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const ownLock = input.lock
    ? null
    : await acquireLeaseWithRetry(
        deps.db,
        input.organizationId,
        nowMs,
        deps.leaseRetry ?? DEFAULT_LEASE_RETRY
      )
  if (!input.lock && !ownLock) {
    logWarn(
      logScope,
      `organization ${input.organizationId}: quantity lease held; entitlement sync deferred to the holder`
    )
    return { action: 'skipped', reason: 'lease_held' }
  }
  try {
    const state = input.state ?? (await listSeatsForOrganization(deps.db, input.organizationId))
    const ended = Boolean(state.subscription) && isEndedStatus(state.subscription!.status)
    let { ledger } = await readPendingChanges(
      deps.db,
      input.organizationId,
      input.providerSubscriptionId
    )

    // 1. Intents whose change the committed items show.
    const landed = landedIntents(ledger, {
      ended,
      currentPeriodEnd: state.subscription?.currentPeriodEnd ?? null,
      seatsAt: seatsAtFromState(state),
    })
    ledger = withoutIntents(
      ledger,
      landed.map((intent) => intent.id)
    )
    ledger = clearLedgerIfSubscriptionEnded(ledger, state)
    await writePendingChanges(deps.db, input.organizationId, ledger, nowMs)

    // 3. An ended subscription revokes everything. The revoked servers keep
    //    the tier their managers gave them; they drop out of the coverage
    //    read because they no longer hold an active license.
    let revoked: { licenseIds: string[]; serverIds: string[] } = { licenseIds: [], serverIds: [] }
    if (ended) {
      revoked = await revokeAllLicensesForOrganization(deps.db, input.organizationId, {
        now,
        onRevokeBound: deps.onRevokeBound,
      })
    }

    // 2. The managers' assignment, read against the seats (never written).
    const assignment = await peekOrganizationAssignment(deps.db, input.organizationId, { state })

    // 4. The schedule, when the ledger still needs one.
    const scheduleRebuilt = await rebuildDeferredScheduleIfNeeded(
      deps,
      input,
      state,
      ledger,
      logScope
    )

    const result: EntitlementSyncResult = {
      landedIntentIds: landed.map((intent) => intent.id),
      assignment,
      revokedLicenseIds: revoked.licenseIds,
      disconnectedServerIds: revoked.serverIds,
    }
    if (assignment.uncovered.length > 0) {
      logWarn(
        logScope,
        `organization ${input.organizationId}: ${assignment.uncovered.length} licensed server(s) not covered by any purchased tier`,
        JSON.stringify(assignment.uncovered)
      )
    } else {
      logInfo(
        logScope,
        `organization ${input.organizationId}: entitlements synced`,
        JSON.stringify({
          landed: result.landedIntentIds.length,
          revoked: revoked.licenseIds.length,
        })
      )
    }
    return { action: 'synced', result, scheduleRebuilt }
  } finally {
    if (ownLock) await endQuantityMutation(deps.db, ownLock).catch(() => {})
  }
}
