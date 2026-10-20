/**
 * Hosted Checkout — the **first** purchase only (C14).
 *
 * The customer is created first, so `metadata[turbopanel_organization_id]`
 * exists before Stripe emits `checkout.session.completed` and the
 * projection can resolve its subject. Every later quantity or tier change
 * goes through `subscriptions.ts` / `schedules.ts`, never a second
 * Checkout.
 *
 * The session carries the same anchor and billing-mode invariant as a
 * direct `POST /v1/subscriptions` (`SUBSCRIPTION_ANCHOR_PARAMS`, verified
 * accepted under `subscription_data` on `2025-08-27.basil`, not yet
 * re-verified on the pinned `2026-09-30.endive`). Tax: automatic tax on,
 * tax-id collection on, and
 * `customer_update[address|name]=auto` so Checkout may write what it
 * collects onto the existing customer — Stripe requires both when a
 * `customer` is passed with `tax_id_collection`.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { Db } from '../../db/connection.ts'
import { getPayerForOrganization, upsertPayer } from './billing-records.ts'
import type { StripeClient } from './client.ts'
import { StripeApiError } from './errors.ts'
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from './customer-subject.ts'
import { IDEMPOTENCY_WINDOW_MS, idempotencyWindow, windowedIdempotencyKey } from './idempotency.ts'
import { createCustomerForOrganization, SUBSCRIPTION_ANCHOR_PARAMS } from './subscriptions.ts'

type StripeObject = Record<string, unknown>

/**
 * How long a Checkout session we create stays open. Stripe accepts 30
 * minutes to 24 hours; an hour is long enough to pay and short enough that a
 * forgotten session clears itself.
 */
export const CHECKOUT_SESSION_LIFETIME_MS = 60 * 60 * 1000

/** Session metadata naming what the session sells, so a reuse can be matched without a local record. */
export const CHECKOUT_TIER_METADATA_KEY = 'turbopanel_tier_id'
export const CHECKOUT_QUANTITY_METADATA_KEY = 'turbopanel_quantity'

/**
 * When a session created at `nowMs` expires: the lifetime counted from the
 * **end** of the current idempotency window. Every retry inside the window
 * sends the same `expires_at` with the same idempotency key (Stripe refuses
 * a key reused with different parameters), and no session is shorter than
 * the lifetime. So a session lives between 60 and 65 minutes.
 */
export function checkoutSessionExpiresAtMs(nowMs: number): number {
  return (idempotencyWindow(nowMs) + 1) * IDEMPOTENCY_WINDOW_MS + CHECKOUT_SESSION_LIFETIME_MS
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Stripe substitutes the session id into the success URL. */
export const CHECKOUT_SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}'

/** Console return URLs for one organization. */
export function checkoutReturnUrls(
  publicBaseUrl: string,
  organizationId: string
): { successUrl: string; cancelUrl: string; portalReturnUrl: string } {
  const base = publicBaseUrl.replace(/\/$/, '')
  const page = `${base}/${encodeURIComponent(organizationId)}/billing`
  return {
    successUrl: `${page}?checkout=success&session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    cancelUrl: `${page}?checkout=cancel`,
    portalReturnUrl: page,
  }
}

export type EnsureCustomerInput = Readonly<{
  organizationId: string
  email?: string | null
  name?: string | null
  now?: string
}>

/**
 * The organization's provider customer: the existing `payer` when there is
 * one, otherwise created and upserted into `payer` immediately. The create
 * is keyed on the organization id and the current idempotency window
 * (`idempotency.ts`), so a retry within the window cannot mint a second
 * customer, and a refused create is not replayed past it.
 */
export async function ensureCustomerForOrganization(
  db: Db,
  client: StripeClient,
  input: EnsureCustomerInput
): Promise<{ providerCustomerId: string; created: boolean }> {
  const existing = await getPayerForOrganization(db, input.organizationId)
  if (existing) {
    return { providerCustomerId: existing.providerCustomerId, created: false }
  }
  const { providerCustomerId } = await createCustomerForOrganization(client, {
    organizationId: input.organizationId,
    email: input.email ?? null,
    name: input.name ?? null,
    idempotencyKey: windowedIdempotencyKey(
      `customer:${input.organizationId}`,
      input.now ? Date.parse(input.now) : Date.now()
    ),
  })
  await upsertPayer(db, {
    provider: 'stripe',
    providerCustomerId,
    subject: { organizationId: input.organizationId, userId: null },
    now: input.now,
  })
  return { providerCustomerId, created: true }
}

export type CreateCheckoutSessionInput = Readonly<{
  providerCustomerId: string
  providerPriceId: string
  quantity: number
  successUrl: string
  cancelUrl: string
  idempotencyKey: string
  organizationId: string
  /** Show Stripe's promotion-code field (`TURBOPANEL_STRIPE_IS_COUPON_ALLOWED`). */
  allowPromotionCodes?: boolean
  tierId: string
  /** Used for the session's `expires_at` (`checkoutSessionExpiresAtMs`); defaults to now. */
  nowMs?: number
}>

/**
 * The first purchase's key: organization, tier, quantity and the current
 * idempotency window (`idempotency.ts`). A retry of the same purchase within
 * the window cannot mint a second session; a refused attempt (say, Stripe
 * Tax not set up yet) is not replayed once the window has closed.
 *
 * `replacing` is the sessions this one takes over from. Without it, going
 * from A to B and back to A inside one window would present A's first key
 * again and Stripe would replay the session that was just expired. With it,
 * every replacement is a new request, while a retry of the *same*
 * replacement (same old sessions) still lands on the same key.
 */
export function checkoutIdempotencyKey(
  organizationId: string,
  tierId: string,
  quantity: number,
  nowMs: number,
  replacing: readonly string[] = []
): string {
  const base = `checkout:${organizationId}:${tierId}:${quantity}`
  return windowedIdempotencyKey(
    replacing.length > 0 ? `${base}:replaces:${[...replacing].sort().join(',')}` : base,
    nowMs
  )
}

export async function createCheckoutSession(
  client: StripeClient,
  input: CreateCheckoutSessionInput
): Promise<{ sessionId: string; url: string }> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new RangeError('checkout quantity must be a positive integer')
  }
  const orgMetadata = {
    [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: input.organizationId,
  }
  const sessionMetadata = {
    ...orgMetadata,
    [CHECKOUT_TIER_METADATA_KEY]: input.tierId,
    [CHECKOUT_QUANTITY_METADATA_KEY]: String(input.quantity),
  }
  const session = await client.post<StripeObject>(
    '/v1/checkout/sessions',
    {
      mode: 'subscription',
      customer: input.providerCustomerId,
      line_items: [{ price: input.providerPriceId, quantity: input.quantity }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      ...(input.allowPromotionCodes ? { allow_promotion_codes: true } : {}),
      metadata: sessionMetadata,
      subscription_data: {
        ...SUBSCRIPTION_ANCHOR_PARAMS,
        metadata: orgMetadata,
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: Math.floor(checkoutSessionExpiresAtMs(input.nowMs ?? Date.now()) / 1000),
    },
    { idempotencyKey: input.idempotencyKey }
  )
  const sessionId = str(session.id)
  const url = str(session.url)
  if (!sessionId || !url) {
    throw new Error('stripe checkout session returned no url')
  }
  return { sessionId, url }
}

/**
 * How an open Checkout session ended up when we tried to expire it:
 * `expired` (we expired it, or it had already expired) or `complete` (the
 * customer paid first — the subscription exists or is about to).
 */
export type ExpireCheckoutOutcome = 'expired' | 'complete'

/**
 * Expire an open Checkout session so its URL stops working, which is what
 * lets a second one be opened without risking two subscriptions.
 *
 * Stripe refuses to expire a session that is not `open`, with the same
 * `invalid_request_error` whether it already expired or was completed. That
 * refusal is read back from the session itself: `expired` means proceed,
 * `complete` means the payment won the race. Anything else — including a
 * session that is still open, or a failed read — rethrows the original
 * failure so the caller can answer it as an ordinary Stripe error.
 *
 * The key names the session: a session expires once, so a retry replays.
 */
export async function expireCheckoutSession(
  client: StripeClient,
  sessionId: string
): Promise<ExpireCheckoutOutcome> {
  try {
    await client.post(
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      {},
      { idempotencyKey: `checkout-expire:${sessionId}` }
    )
    return 'expired'
  } catch (err) {
    if (!(err instanceof StripeApiError) || err.isTransient) throw err
    let status: string | null = null
    try {
      const session = await client.get<StripeObject>(
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`
      )
      status = str(session.status)
    } catch {
      throw err
    }
    if (status === 'expired' || status === 'complete') return status
    throw err
  }
}

export type OpenCheckoutInput = Omit<CreateCheckoutSessionInput, 'idempotencyKey' | 'nowMs'> &
  Readonly<{ nowMs: number }>

export type OpenCheckoutOutcome =
  | Readonly<{ kind: 'session'; sessionId: string; url: string; reused: boolean }>
  /** A session of this customer was paid: the subscription exists or is about to. */
  | Readonly<{ kind: 'subscription_exists' }>

function createdMs(session: StripeObject): number {
  return typeof session.created === 'number' ? session.created * 1000 : 0
}

/**
 * Start a first purchase with Stripe as the only record. Run it inside the
 * quantity lease.
 *
 *  1. A session of this customer completed within the longest a session can
 *     live: the customer already paid, so no second one is created.
 *  2. Every open session of the customer is looked at. A very recent one for
 *     the same tier and quantity (a double click, a quick return) is handed
 *     back as is. Every other is expired; one that turns out to be complete
 *     stops the purchase like step 1.
 *  3. Only then is the new session created, its key carrying the sessions it
 *     replaced so going back to an earlier choice is never answered with that
 *     choice's expired session.
 *
 * A Stripe failure anywhere throws and nothing further is created, so a
 * retry starts again from the listing.
 */
export async function openCheckoutSession(
  client: StripeClient,
  input: OpenCheckoutInput
): Promise<OpenCheckoutOutcome> {
  const { nowMs } = input
  const listQuery = { customer: input.providerCustomerId }
  const recentlyPaid = await client.listAll<StripeObject>('/v1/checkout/sessions', {
    ...listQuery,
    status: 'complete',
    created: { gte: Math.floor((nowMs - CHECKOUT_SESSION_LIFETIME_MS - IDEMPOTENCY_WINDOW_MS) / 1000) },
  })
  if (recentlyPaid.length > 0) return { kind: 'subscription_exists' }

  const open = await client.listAll<StripeObject>('/v1/checkout/sessions', {
    ...listQuery,
    status: 'open',
  })
  const reusable = open.find((session) => {
    const metadata = (session.metadata ?? {}) as Record<string, unknown>
    return (
      str(session.id) !== null &&
      str(session.url) !== null &&
      metadata[CHECKOUT_TIER_METADATA_KEY] === input.tierId &&
      metadata[CHECKOUT_QUANTITY_METADATA_KEY] === String(input.quantity) &&
      nowMs - createdMs(session) < IDEMPOTENCY_WINDOW_MS
    )
  })
  const replaced: string[] = []
  for (const session of open) {
    const id = str(session.id)
    if (!id || session === reusable) continue
    if ((await expireCheckoutSession(client, id)) === 'complete') {
      return { kind: 'subscription_exists' }
    }
    replaced.push(id)
  }
  if (reusable) {
    return {
      kind: 'session',
      sessionId: str(reusable.id) as string,
      url: str(reusable.url) as string,
      reused: true,
    }
  }

  const created = await createCheckoutSession(client, {
    ...input,
    idempotencyKey: checkoutIdempotencyKey(
      input.organizationId,
      input.tierId,
      input.quantity,
      nowMs,
      replaced
    ),
  })
  return { kind: 'session', ...created, reused: false }
}
