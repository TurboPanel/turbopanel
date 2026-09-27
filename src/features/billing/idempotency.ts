/**
 * Windowed idempotency keys for request-shaped Stripe calls.
 *
 * Stripe saves the result of an idempotent request once the endpoint starts
 * executing — **including a 4xx refusal** — and replays it for 24 hours to
 * every request that presents the same key. A key derived only from the
 * request's shape (`customer:<org>`, `checkout:<org>:<tier>:<qty>`) therefore
 * turns one refusal into a day-long outage: the operator fixes the cause
 * (say, the Stripe Tax head-office address) and every retry still gets the
 * saved error back.
 *
 * So those keys carry the current {@link IDEMPOTENCY_WINDOW_MS} window. A
 * double-click or a client/network retry lands in the same window and
 * presents the same key, so Stripe answers it with the first attempt's
 * result instead of creating a second object; an attempt after the window
 * has closed is a new request, and a saved refusal stops being replayed.
 *
 * The window is the second line of defence, not the first. Checkout already
 * serialises on the quantity lease and reuses the stored pending-checkout
 * record, and the customer is looked up from `payer` before it is ever
 * created. The key only covers the gap where Stripe applied a call whose
 * response we never recorded; a retry of that gap more than a window later
 * can create a duplicate (an orphan customer, or a second open Checkout
 * session that expires unused) — the accepted cost of never being locked
 * out for a day.
 *
 * Mutations with a persisted record (`seat-increase.ts`, the pending-change
 * ledger) do not use this: they reuse the stored key while a transient
 * failure may have applied, and drop it on a permanent refusal.
 *
 * Workers-bundleable: nothing at module load.
 */

/** How long a request-shaped key is reused: five minutes. */
export const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

/** The window `nowMs` falls in — whole windows since the epoch. */
export function idempotencyWindow(nowMs: number): number {
  return Math.floor(nowMs / IDEMPOTENCY_WINDOW_MS)
}

/** `base` suffixed with the current window, e.g. `customer:<org>:w5874123`. */
export function windowedIdempotencyKey(base: string, nowMs: number): string {
  return `${base}:w${idempotencyWindow(nowMs)}`
}
