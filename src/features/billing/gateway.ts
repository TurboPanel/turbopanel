/**
 * The payment-gateway seam.
 *
 * TurboPanel bills through Stripe today and may bill through something
 * else tomorrow. This module is the part of the billing tree the rest of
 * the instance is allowed to name: a {@link BillingGateway} that answers
 * catalogue questions (which products exist, what does one cost, is it
 * shaped the way a tier needs) without Stripe vocabulary leaking into the
 * admin routes or the UI. Rows in `tier` and `payer` carry a `provider`
 * discriminator (`BillingProviderId`) so a second gateway can coexist.
 *
 * What is **not** behind this seam yet, and where it lives:
 *
 *   - Checkout, the Customer Portal, subscription item mutation and the
 *     schedule (deferred) phases — `checkout.ts`, `portal.ts`,
 *     `subscriptions.ts`, `schedules.ts`, driven by `StripeClient`.
 *   - The webhook projection — `src/webhook/billing/stripe-projection.ts`.
 *
 * Those are shaped by Stripe's data model (pending updates, schedules with
 * contiguous phases, proration invoices), and abstracting them before a
 * second gateway exists would be guessing at its shape. Adding one means:
 * a second `BillingGateway` implementation here, a second projection under
 * `src/webhook/billing/`, and routing on `provider` in the mutation routes.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { TierLabel } from '../tiers/ladder.ts'
import type { StripeClient } from './client.ts'
import { createStripeGateway } from './stripe-products.ts'

/**
 * Matches `payer_provider_check` and `tier_provider_check` (pinned by
 * `src/db/enum-checks.test.ts`). Stripe only: `apple` was reserved here
 * and in both CHECKs until 2026-09-17, then dropped before the first tag
 * (decided 2026-09-12 — "way down the line, and we are only doing Stripe").
 * A second gateway is added here, in the two CHECKs, and behind
 * `BillingGateway` together.
 */
export const BILLING_PROVIDER_IDS = ['stripe'] as const

export type BillingProviderId = (typeof BILLING_PROVIDER_IDS)[number]

/** The price a product bills at, as much as a tier needs to know. */
export type ProviderPrice = Readonly<{
  id: string
  active: boolean
  /** `recurring` or `one_time`. */
  type: string | null
  /** Lower-case ISO code. */
  currency: string
  /** Minor units (cents). */
  unitAmount: number | null
  interval: string | null
  intervalCount: number | null
  /** `per_unit` or `tiered`. */
  billingScheme: string | null
  /** `inclusive`, `exclusive` or `unspecified`. */
  taxBehavior: string | null
  livemode: boolean
}>

/** One product on the provider's catalogue, with the price it sells at. */
export type ProviderProduct = Readonly<{
  id: string
  name: string
  active: boolean
  livemode: boolean
  metadata: Readonly<Record<string, string>>
  /**
   * The ladder label the product names in its metadata
   * (`turbopanel_tier`), when it names a valid one — what the admin form
   * preselects so nobody types "S3" twice.
   */
  suggestedLabel: TierLabel | null
  /** The product's default price; `null` when it has none (unsellable). */
  defaultPrice: ProviderPrice | null
}>

/**
 * The provider account's own tax configuration.
 *
 * Stripe documents a price's `tax_behavior` as "only required if a
 * default tax behavior was not provided in the Stripe Tax settings", and
 * recommends setting that account-level default rather than stamping every
 * price. A price left at `unspecified` under such an account is therefore
 * correct, not broken, and verification must not refuse it.
 */
export type ProviderTaxDefaults = Readonly<{
  /** What the lookup found; see {@link ProviderTaxDefaultsOutcome}. */
  outcome: ProviderTaxDefaultsOutcome
  /**
   * `inclusive`, `exclusive` or `inferred_by_currency` (the Dashboard's
   * "Automatic": exclusive for USD and CAD, inclusive for other
   * currencies) when the account sets a default; `null` for every other
   * outcome.
   */
  taxBehavior: string | null
  /** `active` once the provider can calculate tax; `pending` while incomplete. */
  status: string | null
  /** Why the provider refused, when it did. Typed fields only, never its message. */
  error: ProviderTaxDefaultsError | null
}>

/**
 * How the account tax default lookup ended. Each one needs a different fix,
 * so they are never folded together:
 *
 *   set                 the provider named a default (`taxBehavior`)
 *   unset               the provider answered and names no default
 *   not_asked           no price needed the default, so nobody asked
 *   permission_missing  the key may not read tax settings (HTTP 403)
 *   provider_error      any other refusal or failure; `error` says which
 */
export type ProviderTaxDefaultsOutcome =
  'set' | 'unset' | 'not_asked' | 'permission_missing' | 'provider_error'

export type ProviderTaxDefaultsError = Readonly<{
  status: number
  type: string
  code: string | null
  /**
   * The permission the provider says the key lacks (Stripe names it as
   * `rak_…` in a restricted key's 403), when it names one.
   */
  permission: string | null
}>

/**
 * The account was not asked, because no price needed its default. Every
 * price must then speak for itself.
 */
export const NO_TAX_DEFAULTS: ProviderTaxDefaults = {
  outcome: 'not_asked',
  taxBehavior: null,
  status: null,
  error: null,
}

/** Whether a tax-behaviour string actually names a behaviour. */
export function isResolvedTaxBehavior(value: string | null): boolean {
  return value === 'inclusive' || value === 'exclusive'
}

/**
 * Whether the ACCOUNT's tax default names a behaviour. Unlike a price,
 * which is only `inclusive`, `exclusive` or `unspecified`, the account
 * default may also be `inferred_by_currency` ("Automatic"), which Stripe
 * resolves per currency, so a price left `unspecified` under it is fine.
 */
export function isResolvedAccountTaxDefault(value: string | null): boolean {
  return isResolvedTaxBehavior(value) || value === 'inferred_by_currency'
}

/**
 * Whether verifying this product requires asking the provider for the
 * account's tax defaults. A price that names its own behaviour answers the
 * question by itself, so the common case costs no extra round trip.
 */
export function needsAccountTaxDefaults(product: ProviderProduct): boolean {
  return product.defaultPrice !== null && !isResolvedTaxBehavior(product.defaultPrice.taxBehavior)
}

export type ProductVerification = Readonly<{
  /** No failures — a tier may bill against this product. */
  ok: boolean
  product: ProviderProduct
  failures: readonly string[]
}>

/** The ladder entry a priced-tier bind must match — SX has none. */
export type ProductLadderExpectation = Readonly<{
  label: TierLabel
  listPriceCents: number
}>

/** The metadata key a product uses to name its ladder label. */
export const PRODUCT_TIER_METADATA_KEY = 'turbopanel_tier'

export interface BillingGateway {
  readonly id: BillingProviderId
  /** Every active product with its default price expanded — the admin dropdown. */
  listProducts(): Promise<ProviderProduct[]>
  /** One product with its default price; throws the provider's error when absent. */
  getProduct(productId: string): Promise<ProviderProduct>
  /**
   * The account's tax defaults. A provider refusal never throws: it comes
   * back as an outcome naming the reason (`permission_missing`,
   * `provider_error`, …) with no default, which only makes verification
   * stricter, never laxer, and keeps the admin dropdown working.
   */
  getTaxDefaults(): Promise<ProviderTaxDefaults>
  /**
   * Every reason this product cannot back a tier row. Pure — the caller
   * supplies the account defaults so one lookup serves a whole listing.
   * When `expected` is set, the product must also name that ladder label and
   * sell at that list price; omit it for the generic catalogue dropdown.
   */
  verifyProduct(
    product: ProviderProduct,
    taxDefaults: ProviderTaxDefaults,
    expected?: ProductLadderExpectation | null
  ): ProductVerification
}

/** The gateway for this instance's configured provider — Stripe, today. */
export function resolveBillingGateway(client: StripeClient): BillingGateway {
  return createStripeGateway(client)
}
