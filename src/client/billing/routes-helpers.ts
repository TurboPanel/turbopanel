/**
 * Pure helpers and shared guards for the billing client surface.
 *
 * Everything here is either a body parser, a serializer, or a guard that
 * reads already-loaded state. No provider call, no Postgres write.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { describeStripeError, StripeApiError } from '../../features/billing/errors.ts'
import { logError, logWarn } from '../../lib/logger.ts'
import {
  deferredDeltasByTier,
  endingLicensesByTier,
  outstandingReleasesByTier,
  type PendingChangeLedger,
  readPendingChanges,
} from '../../features/billing/pending-changes.ts'
import {
  isDelinquentStatus,
  isEndedStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
  seatQuantitiesByTier,
} from '../../features/billing/billing-records.ts'
import {
  countActiveLicenses,
  type LicenseCount,
  type TierRow,
} from '../../features/tiers/tier-records.ts'
import {
  applyTierDeltas,
  coverageLoss,
  type TierQuantity,
} from '../../features/tiers/assignment.ts'
import {
  type AssignedServerRow,
  loadAssignableServers,
  tierQuantitiesFromState,
} from '../../features/tiers/assignment-records.ts'
import { ladderEntry, ladderEntryByRank } from '../../features/tiers/ladder.ts'
import type { TierDelta } from '../../features/billing/subscriptions.ts'
import { listProvisioningLicenses } from '../../features/licenses/enroll-attempt.ts'

export const BILLING_NOT_CONFIGURED_ERROR = 'billing_not_configured'
export const BILLING_MUTATION_IN_PROGRESS_ERROR = 'billing_mutation_in_progress'
export const SUBSCRIPTION_PAST_DUE_ERROR = 'subscription_past_due'
export const SUBSCRIPTION_EXISTS_ERROR = 'subscription_exists'
export const CHECKOUT_PENDING_ERROR = 'checkout_pending'
export const NO_SUBSCRIPTION_ERROR = 'no_subscription'
/** A reduction would leave a licensed server on nothing. */
export const SERVERS_UNCOVERED_ERROR = 'servers_uncovered'
/** A reduction would leave more licenses than purchased. */
export const LICENSES_IN_USE_ERROR = 'licenses_in_use'
/** Nothing purchased is free for another server. */
export const NO_LICENSE_AVAILABLE_ERROR = 'no_license_available'
/**
 * More of a tier was asked for while licenses at that tier are ending at the
 * boundary: restore those first (`POST /billing/restore`, free). Ending
 * licenses at another tier never refuse.
 */
export const LICENSES_ENDING_ERROR = 'licenses_ending'
/** `POST /billing/restore` at a tier with nothing ending. */
export const NO_LICENSES_ENDING_ERROR = 'no_licenses_ending'
export const TIER_NOT_PURCHASABLE_ERROR = 'tier_not_purchasable'
export const NOT_AN_UPGRADE_ERROR = 'not_an_upgrade'
export const NOT_A_DOWNGRADE_ERROR = 'not_a_downgrade'
export const STRIPE_ERROR = 'stripe_error'
/** Log scope for a Stripe refusal behind a client billing route. */
export const BILLING_ROUTES_LOG_SCOPE = 'billing'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Rejection sentinel for {@link readUuidField}.
 *
 * A symbol rather than the string `'invalid'`: that token is itself a
 * `string`, so `string | 'invalid'` collapses and cannot be told apart from
 * a body that actually sent it.
 */
export const PARSE_UUID_INVALID: unique symbol = Symbol('parse_uuid_invalid')

export function readUuidField(
  record: Record<string, unknown>,
  key: string
): string | null | typeof PARSE_UUID_INVALID {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return PARSE_UUID_INVALID
  const trimmed = value.trim()
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : PARSE_UUID_INVALID
}

export function readIntField(
  record: Record<string, unknown>,
  key: string
): number | null | 'invalid' {
  const value = record[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid'
  return value
}

/** `null` when the body is absent/blank; `'invalid'` when it is not a JSON object. */
export function parseJsonObjectBody(raw: string): Record<string, unknown> | null | 'invalid' {
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid'
    return parsed as Record<string, unknown>
  } catch {
    return 'invalid'
  }
}

/** Everything a billing page or mutation reads, in one Postgres round of reads. */
export type BillingOrgView = Readonly<{
  state: OrganizationBillingState
  /** Active licenses the organization holds, bound or not. */
  licenses: LicenseCount
  /** Every licensed server with its hardware requirement and current assignment. */
  servers: readonly AssignedServerRow[]
  ledger: PendingChangeLedger
}>

export async function loadBillingOrgView(
  db: Db,
  organizationId: string,
  _nowMs: number
): Promise<BillingOrgView> {
  const state = await listSeatsForOrganization(db, organizationId)
  const counted = await countActiveLicenses(db, organizationId)
  // Only read the enrol-attempt records when some key is still unbound.
  const licenses = {
    ...counted,
    provisioning:
      counted.active > counted.bound
        ? (await listProvisioningLicenses(db, organizationId)).size
        : 0,
  }
  const servers = await loadAssignableServers(db, organizationId)
  const { ledger } = state.subscription
    ? await readPendingChanges(db, organizationId, state.subscription.providerSubscriptionId)
    : {
        ledger: { version: 2 as const, providerSubscriptionId: '', intents: [] },
      }
  return { state, licenses, servers, ledger }
}

export type TierSummary = Readonly<{
  tierId: string
  label: string
  rank: number
  /** Committed quantity — the licenses bought at this tier. */
  purchased: number
  /** Servers currently assigned this tier. */
  inUse: number
  /** Of `purchased`, the licenses that end at the period boundary and can be restored. */
  ending: number
  /** When they end (ISO), or `null` when nothing is ending. */
  endsAt: string | null
  /**
   * `purchased − ending − inUse`, floored at zero and capped at the
   * organization-wide `licenses.available`. The cap is what keeps the two in
   * agreement: an unused registration key holds a license but has no tier
   * until its server connects, so it can only be charged org-wide — without
   * the cap a tier would show a license "free" that the mint gate refuses.
   */
  available: number
  /**
   * @deprecated Use `ending`. Kept one release for the console: every seat
   * leaving the tier at the boundary, a pending downgrade's included.
   */
  releasing: number
  priceCents: number | null
  currency: string | null
}>

/** Per-tier purchased vs in use, in ladder order. */
export function summarizeTiers(view: BillingOrgView): TierSummary[] {
  const orgAvailable = summarizeLicenses(view).available
  const seats = seatQuantitiesByTier(view.state)
  const releases = outstandingReleasesByTier(view.ledger)
  const ending = endingLicensesByTier(view.ledger)
  const inUse = new Map<string, number>()
  for (const server of view.servers) {
    if (server.assignedTierId) {
      inUse.set(server.assignedTierId, (inUse.get(server.assignedTierId) ?? 0) + 1)
    }
  }
  const out: TierSummary[] = []
  for (const seat of view.state.seats) {
    if (out.some((entry) => entry.tierId === seat.tierId)) continue
    const purchased = seats.get(seat.tierId) ?? 0
    const used = inUse.get(seat.tierId) ?? 0
    const endingHere = ending.get(seat.tierId)
    out.push({
      tierId: seat.tierId,
      label: seat.tier.label,
      rank: seat.tier.rank,
      purchased,
      inUse: used,
      ending: endingHere?.count ?? 0,
      endsAt: endingHere?.endsAt ?? null,
      available: Math.min(orgAvailable, Math.max(0, purchased - (endingHere?.count ?? 0) - used)),
      releasing: releases.get(seat.tierId) ?? 0,
      priceCents: seat.tier.priceCents,
      currency: seat.tier.currency,
    })
  }
  return out.sort((a, b) => a.rank - b.rank)
}

export type LicenseSummary = Readonly<{
  /**
   * Total entitled quantity across tiers — projected provider seats plus
   * the self-hosted grant. The grant is the reason a self-hosted
   * organization has any entitlement at all; it has no price and no tier
   * line, so `purchased` can exceed the sum of {@link summarizeTiers}.
   */
  purchased: number
  /** Of `purchased`, the part that is a grant rather than a purchase. */
  granted: number
  /** Of `purchased`, how many leave at the period boundary. */
  releasing: number
  /** Of `purchased`, the licenses that end at the boundary and can be restored (no downgrades). */
  ending: number
  /** The earliest date any of them ends (ISO), or `null`. */
  endsAt: string | null
  /**
   * Active licenses held, bound or waiting to connect: `inUse + unusedKeys`.
   * @deprecated for display — show `inUse` and `unusedKeys`; it stays the
   * number the mint gate subtracts.
   */
  held: number
  /** What the console calls "in use": `bound + provisioning`. */
  inUse: number
  /** Licenses bound to a server. */
  bound: number
  /**
   * Registration keys whose daemon has started enrolling but whose server
   * is not bound yet — a server being provisioned. In use, never free.
   */
  provisioning: number
  /**
   * Registration keys nobody has used yet (`held − bound − provisioning`).
   * Each holds a license until it is used or deleted, and carries no tier
   * until its server connects, so it is counted organization-wide only.
   */
  unusedKeys: number
  /** `purchased − releasing − held`, floored at zero: how many more servers can be added. */
  available: number
}>

export function summarizeLicenses(view: BillingOrgView): LicenseSummary {
  // `tierQuantitiesFromState`, not `seatQuantitiesByTier`: the mint gate is
  // an entitlement question, so it counts the self-hosted grant.
  let purchased = 0
  for (const entry of tierQuantitiesFromState(view.state)) {
    purchased += entry.quantity
  }
  const granted = view.state.grant?.quantity ?? 0
  let releasing = 0
  for (const count of outstandingReleasesByTier(view.ledger).values()) {
    releasing += count
  }
  const held = view.licenses.active
  // Clamped: a key counts as provisioning only while it is active and unbound.
  const provisioning = Math.min(
    view.licenses.provisioning ?? 0,
    Math.max(0, held - view.licenses.bound)
  )
  let ending = 0
  let endsAt: string | null = null
  for (const entry of endingLicensesByTier(view.ledger).values()) {
    ending += entry.count
    if (entry.endsAt && (endsAt === null || entry.endsAt < endsAt)) endsAt = entry.endsAt
  }
  return {
    purchased,
    granted,
    releasing,
    ending,
    endsAt,
    held,
    inUse: view.licenses.bound + provisioning,
    bound: view.licenses.bound,
    provisioning,
    unusedKeys: Math.max(0, held - view.licenses.bound - provisioning),
    available: Math.max(0, purchased - releasing - held),
  }
}

/** The mint gate: one more license fits under what is purchased and not already leaving. */
export function canMintLicense(view: BillingOrgView): boolean {
  return summarizeLicenses(view).available > 0
}

export type LicensesEndingRefusal = {
  error: typeof LICENSES_ENDING_ERROR
  tierId: string
  ending: number
  endsAt: string | null
}

/**
 * Restore before buy, per tier: asking for more of `tierId` while licenses
 * at that tier are ending is refused — the person restores those (free)
 * first, so nobody pays for a new license with one sitting there. Only
 * `release-seat` intents at that same tier count.
 */
export function licensesEndingRefusal(
  ledger: PendingChangeLedger,
  tierId: string
): LicensesEndingRefusal | null {
  const ending = endingLicensesByTier(ledger).get(tierId)
  if (!ending || ending.count === 0) return null
  return { error: LICENSES_ENDING_ERROR, tierId, ending: ending.count, endsAt: ending.endsAt }
}

/** `Oct 26` for an ISO instant, in UTC (the boundary Stripe bills on). */
export function formatEndsOn(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

type ExhaustionSummary = Pick<
  LicenseSummary,
  'purchased' | 'releasing' | 'inUse' | 'provisioning' | 'unusedKeys' | 'ending' | 'endsAt'
>

function inUsePart({ inUse, provisioning }: ExhaustionSummary): string | null {
  if (inUse <= 0) return null
  return provisioning > 0 ? `${inUse} in use (${provisioning} provisioning)` : `${inUse} in use`
}

function unusedKeysPart({ unusedKeys }: ExhaustionSummary): string | null {
  if (unusedKeys <= 0) return null
  return unusedKeys === 1
    ? '1 held by an unused registration key'
    : `${unusedKeys} held by unused registration keys`
}

function endingPart({ ending, endsAt }: ExhaustionSummary): string | null {
  if (ending <= 0) return null
  const endsOn = formatEndsOn(endsAt)
  const when = endsOn ? ` ${endsOn}` : ' at the end of the billing period'
  return `${ending} ${ending === 1 ? 'ends' : 'end'}${when}`
}

/**
 * Licenses that only move tier at the boundary: leaving, but not ending
 * (a pending downgrade) and not already taken by a held license. This is the
 * mint gate's arithmetic (`purchased` minus what is held). What is held is
 * `inUse + unusedKeys`: a bound license is always an active one (both come
 * from one `countActiveLicenses` query), so `bound <= held` and the two
 * display fields sum to the deprecated `held` exactly.
 */
function changingTierCount(summary: ExhaustionSummary): number {
  const held = summary.inUse + summary.unusedKeys
  return Math.min(
    Math.max(0, summary.releasing - summary.ending),
    Math.max(0, summary.purchased - held)
  )
}

function changingTierPart(moving: number): string | null {
  return moving > 0 ? `${moving} changing tier at the end of the billing period` : null
}

/** The cheapest way out for what the parts name, or `null` when they name only licenses in use. */
function exhaustionAdvice(summary: ExhaustionSummary, moving: number): string | null {
  const { unusedKeys, ending } = summary
  if (unusedKeys > 0 && ending > 0) {
    return 'use or delete the unused key, or restore one, to add this server.'
  }
  if (unusedKeys > 0) {
    const it = unusedKeys === 1 ? 'it' : 'one'
    return `delete ${it} or use ${it} to add this server.`
  }
  if (ending > 0) return 'restore one to add this server.'
  if (moving > 0) return 'buy another to add this server now.'
  return null
}

/** Every license is in use: the closing sentence when nothing else is named. */
function allInUseSentence({ purchased, provisioning }: ExhaustionSummary): string {
  const all = purchased === 1 ? 'Your only license is' : `All ${purchased} licenses are`
  const note = provisioning > 0 ? ` (${provisioning} provisioning)` : ''
  return `${all} in use${note} — buy another to add this server.`
}

/**
 * The sentence Add Server shows when no license is free. It names every
 * reason a purchased license is not available, never calling an ending
 * license or an unused registration key "in use", and ends with the cheapest
 * way out: use or delete the unused key, restore an ending license (both
 * free), and only then buy one. A license only moving tier at the boundary
 * (a pending downgrade, which the mint gate also holds back) is named as such.
 *
 * The parts are built from `inUse` and `unusedKeys` (the display fields).
 */
export function licenseExhaustionMessage(summary: ExhaustionSummary): string {
  if (summary.purchased === 0) return 'No licenses yet — buy one to add this server.'
  const moving = changingTierCount(summary)
  const parts = [
    inUsePart(summary),
    unusedKeysPart(summary),
    endingPart(summary),
    changingTierPart(moving),
  ].filter((part): part is string => part !== null)
  const advice = exhaustionAdvice(summary, moving)
  if (advice === null) return allInUseSentence(summary)
  return `${parts.join(', ')} — ${advice}`
}

export function hasLiveSubscription(view: BillingOrgView): boolean {
  return Boolean(view.state.subscription) && !isEndedStatus(view.state.subscription!.status)
}

/** Current committed quantities per tier, with rank. */
export function currentTierQuantities(view: BillingOrgView): TierQuantity[] {
  return tierQuantitiesFromState(view.state)
}

export type CoverageRefusal =
  | {
      error: typeof SERVERS_UNCOVERED_ERROR
      serverId: string
      requiredTier: string
    }
  | {
      error: typeof LICENSES_IN_USE_ERROR
      purchasedAfter: number
      licensesHeld: number
    }

/**
 * The gate every reduction and deferred change runs: apply the ledger's
 * outstanding deltas **and** the proposed ones to the committed
 * quantities, and refuse when a licensed server would go uncovered or the
 * organization would hold more licenses than it pays for.
 *
 * `rankOf` resolves a tier the seats do not yet carry (a downgrade target).
 */
export function coverageRefusal(
  view: BillingOrgView,
  proposed: readonly TierDelta[],
  rankOf: (tierId: string) => number | undefined
): CoverageRefusal | null {
  const current = currentTierQuantities(view)
  const deltas = deferredDeltasByTier(view.ledger)
  for (const { tierId, delta } of proposed) {
    deltas.set(tierId, (deltas.get(tierId) ?? 0) + delta)
  }
  let future: TierQuantity[]
  try {
    future = applyTierDeltas(current, deltas, rankOf)
  } catch (err) {
    // A tier going negative is the caller's arithmetic, refused as invalid
    // upstream. An unresolvable rank is a bug in the caller's resolver and
    // must not read as "safe".
    if (err instanceof RangeError) return null
    throw err
  }
  const purchasedAfter = future.reduce((sum, entry) => sum + entry.quantity, 0)
  if (purchasedAfter < view.licenses.active) {
    return {
      error: LICENSES_IN_USE_ERROR,
      purchasedAfter,
      licensesHeld: view.licenses.active,
    }
  }
  const loss = coverageLoss(current, future, view.servers)
  if (loss) {
    return {
      error: SERVERS_UNCOVERED_ERROR,
      serverId: loss.serverId,
      requiredTier: ladderEntryByRank(loss.requiredRank)?.label ?? `rank ${loss.requiredRank}`,
    }
  }
  return null
}

/** The catalogue entry the console renders: the row plus what the ladder says it entitles. */
export function serializeTier(row: TierRow) {
  const entry = ladderEntry(row.label)
  return {
    id: row.id,
    label: row.label,
    rank: row.rank,
    priceCents: row.priceCents,
    currency: row.currency,
    isCustom: row.isCustom,
    entitlements: entry
      ? {
          maxCores: entry.maxCores,
          maxMemoryBytes: entry.maxMemoryBytes,
          nicSlots: entry.nicSlots,
          driveSlots: entry.driveSlots,
          gpuSlots: entry.gpuSlots,
          filesystemSlots: entry.filesystemSlots,
        }
      : null,
  }
}

/** {@link LicenseSummary} minus the fields that are internal plumbing. */
function publicLicenseSummary(summary: LicenseSummary): Omit<LicenseSummary, 'granted'> {
  const { granted: _granted, ...rest } = summary
  return rest
}

export function serializeSubscriptionSummary(view: BillingOrgView) {
  const sub = view.state.subscription
  return {
    payer: view.state.payer ? { taxId: view.state.payer.taxId } : null,
    subscription: sub
      ? {
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          pastDueSince: sub.pastDueSince,
          graceExpiresAt: sub.graceExpiresAt,
          scheduleAttached: sub.scheduleId !== null,
        }
      : null,
    tiers: summarizeTiers(view),
    // `granted` is dropped on the way out: the self-hosted grant is
    // plumbing, not something the console renders or a customer bought. It
    // still moves `purchased` and `available`, which is the whole point.
    licenses: publicLicenseSummary(summarizeLicenses(view)),
    servers: view.servers.map((server) => ({
      serverId: server.serverId,
      assignedTierId: server.assignedTierId,
      requiredTier:
        server.requiredRank === null
          ? null
          : (ladderEntryByRank(server.requiredRank)?.label ?? null),
    })),
    pendingChanges: view.ledger.intents.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      fromTierId: intent.fromTierId,
      toTierId: intent.toTierId,
      createdAt: intent.createdAt,
      landsAt: intent.landsAt,
    })),
  }
}

/**
 * C8 — no entitlement-raising change while the subscription is delinquent.
 * A pending update expires in 23 h and Smart Retries are days apart, so it
 * could never apply; refusing up front is the honest answer.
 */
export function assertTierChangeAllowed(c: Context<AppEnv>, view: BillingOrgView): Response | null {
  const refusal = tierChangeRefusal(view)
  return refusal ? c.json(refusal, 409) : null
}

export type TierChangeRefusal =
  | { error: typeof NO_SUBSCRIPTION_ERROR }
  | {
      error: typeof SUBSCRIPTION_PAST_DUE_ERROR
      graceExpiresAt: string | null
    }

/**
 * The C8 gate as a value: the `409` body an entitlement-raising change
 * gets, or `null` when it may go ahead. `mutations.ts` and the live harness
 * read this; the routes wrap it in a `Response` above.
 */
export function tierChangeRefusal(view: BillingOrgView): TierChangeRefusal | null {
  const sub = view.state.subscription
  if (!sub || isEndedStatus(sub.status)) {
    return { error: NO_SUBSCRIPTION_ERROR }
  }
  if (isDelinquentStatus(sub.status)) {
    return {
      error: SUBSCRIPTION_PAST_DUE_ERROR,
      graceExpiresAt: sub.graceExpiresAt,
    }
  }
  return null
}

/**
 * Map a Stripe failure to a client answer without leaking the raw body. The
 * reason Stripe gave goes to the operator log instead — the client body
 * carries only the typed fields, so without the log a refusal is opaque.
 */
export function stripeErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof StripeApiError) {
    ;(err.isTransient ? logWarn : logError)(
      BILLING_ROUTES_LOG_SCOPE,
      `Stripe refused ${c.req.method} ${c.req.path}: ${describeStripeError(err)}`
    )
    return c.json(
      {
        error: STRIPE_ERROR,
        type: err.type,
        code: err.code,
        transient: err.isTransient,
      },
      err.isTransient ? 503 : 502
    )
  }
  throw err
}
