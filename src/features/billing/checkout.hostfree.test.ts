/**
 * Host-free coverage for hosted Checkout (ledger T4): the complete form the
 * session is created with — every key, in order — the console return URLs,
 * and the customer-ensure step that must run before the session so the
 * first webhook can resolve its subject.
 */

import { assertEquals, assertRejects } from '@std/assert'
import { payer } from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { StripeApiError } from './errors.ts'
import { createStripeClientDouble, type StripeCall } from '../../test-fixtures/stripe-client.ts'
import {
  CHECKOUT_SESSION_ID_PLACEHOLDER,
  CHECKOUT_SESSION_LIFETIME_MS,
  checkoutSessionExpiresAtMs,
  expireCheckoutSession,
  checkoutIdempotencyKey,
  checkoutReturnUrls,
  createCheckoutSession,
  ensureCustomerForOrganization,
} from './checkout.ts'
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from './customer-subject.ts'
import { IDEMPOTENCY_WINDOW_MS, windowedIdempotencyKey } from './idempotency.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const NOW = '2026-09-07T12:00:00.000Z'

test('T4 · the Checkout session form, key by key: subscription mode, the customer, one line, tax on, customer update auto, the anchor block, both URLs', async () => {
  const client = createStripeClientDouble((call: StripeCall) => {
    if (call.method === 'POST' && call.path === '/v1/checkout/sessions') {
      return {
        id: 'cs_1',
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
      }
    }
    throw new Error(`unexpected ${call.method} ${call.path}`)
  })
  const urls = checkoutReturnUrls('https://panel.example.com', ORG)
  const out = await createCheckoutSession(client, {
    providerCustomerId: 'cus_1',
    providerPriceId: 'price_S3',
    quantity: 2,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
    idempotencyKey: 'checkout-key-1',
    organizationId: ORG,
    tierId: 'tier-1',
    nowMs: Date.parse(NOW),
  })
  assertEquals(out, {
    sessionId: 'cs_1',
    url: 'https://checkout.stripe.com/c/pay/cs_1',
  })

  assertEquals(client.calls.length, 1)
  const call = client.calls[0]!
  assertEquals(call.idempotencyKey, 'checkout-key-1')
  // The golden body. Order matters to nobody but a reader; completeness does:
  // a key missing here is a key Stripe silently defaults.
  assertEquals(call.form, [
    ['mode', 'subscription'],
    ['customer', 'cus_1'],
    ['line_items[0][price]', 'price_S3'],
    ['line_items[0][quantity]', '2'],
    ['automatic_tax[enabled]', 'true'],
    ['tax_id_collection[enabled]', 'true'],
    ['customer_update[address]', 'auto'],
    ['customer_update[name]', 'auto'],
    [`metadata[${STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY}]`, ORG],
    ['metadata[turbopanel_tier_id]', 'tier-1'],
    ['metadata[turbopanel_quantity]', '2'],
    ['subscription_data[billing_mode][type]', 'flexible'],
    ['subscription_data[billing_cycle_anchor_config][day_of_month]', '1'],
    ['subscription_data[billing_cycle_anchor_config][hour]', '0'],
    ['subscription_data[billing_cycle_anchor_config][minute]', '0'],
    ['subscription_data[billing_cycle_anchor_config][second]', '0'],
    [`subscription_data[metadata][${STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY}]`, ORG],
    [
      'success_url',
      `https://panel.example.com/${ORG}/billing?checkout=success&session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    ],
    ['cancel_url', `https://panel.example.com/${ORG}/billing?checkout=cancel`],
    ['expires_at', String(Math.floor(checkoutSessionExpiresAtMs(Date.parse(NOW)) / 1000))],
  ])
})

test('T4 · the promotion-code field is sent only when coupons are allowed', async () => {
  const client = createStripeClientDouble(() => ({
    id: 'cs_1',
    object: 'checkout.session',
    url: 'https://checkout.stripe.com/c/pay/cs_1',
  }))
  const base = {
    providerCustomerId: 'cus_1',
    providerPriceId: 'price_S3',
    tierId: 'tier-1',
    quantity: 1,
    successUrl: 'https://panel.example.com/ok',
    cancelUrl: 'https://panel.example.com/cancel',
    idempotencyKey: 'checkout-key-1',
    organizationId: ORG,
  }
  await createCheckoutSession(client, { ...base, allowPromotionCodes: true })
  await createCheckoutSession(client, { ...base, allowPromotionCodes: false })
  const promo = (i: number) => client.calls[i]!.form.filter(([k]) => k === 'allow_promotion_codes')
  assertEquals(promo(0), [['allow_promotion_codes', 'true']])
  assertEquals(promo(1), [])
})

test('T4 · the Checkout idempotency key is deterministic per organization, tier, quantity and idempotency window', () => {
  const at = Date.parse(NOW)
  assertEquals(
    checkoutIdempotencyKey(ORG, 'tier-1', 2, at),
    windowedIdempotencyKey(`checkout:${ORG}:tier-1:2`, at)
  )
  // A double-click or network retry in the same window presents the same key…
  assertEquals(
    checkoutIdempotencyKey(ORG, 'tier-1', 2, at + 1_000),
    checkoutIdempotencyKey(ORG, 'tier-1', 2, at)
  )
  // …but once the window has closed a retry is a new request, so a refusal
  // Stripe saved against the old key is not replayed.
  assertEquals(
    checkoutIdempotencyKey(ORG, 'tier-1', 2, at + IDEMPOTENCY_WINDOW_MS) ===
      checkoutIdempotencyKey(ORG, 'tier-1', 2, at),
    false
  )
})

test('T4 · the return URLs: base without its trailing slash, the organization in the path, the session placeholder verbatim', () => {
  const urls = checkoutReturnUrls('https://panel.example.com/', ORG)
  assertEquals(
    urls.successUrl,
    `https://panel.example.com/${ORG}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`
  )
  assertEquals(urls.cancelUrl, `https://panel.example.com/${ORG}/billing?checkout=cancel`)
  assertEquals(urls.portalReturnUrl, `https://panel.example.com/${ORG}/billing`)
  // Stripe substitutes the placeholder only when it arrives unencoded.
  assertEquals(urls.successUrl.includes('%7B'), false)
})

test('T4 · a non-positive or fractional quantity is refused before any Stripe call; a session with no url is an error', async () => {
  const client = createStripeClientDouble(() => ({
    id: 'cs_1',
    object: 'checkout.session',
  }))
  const base = {
    providerCustomerId: 'cus_1',
    providerPriceId: 'price_S3',
    successUrl: 's',
    cancelUrl: 'c',
    idempotencyKey: 'k',
    organizationId: ORG,
    tierId: 'tier-1',
  }
  for (const quantity of [0, -1, 1.5, Number.NaN]) {
    await assertRejects(() => createCheckoutSession(client, { ...base, quantity }), RangeError)
  }
  assertEquals(client.calls, [])
  await assertRejects(
    () => createCheckoutSession(client, { ...base, quantity: 1 }),
    Error,
    'no url'
  )
})

test('T4 · ensureCustomerForOrganization reuses the projected payer, else creates the customer once under an organization-keyed idempotency key and writes payer immediately', async () => {
  const db = createMemoryDb([[payer, []]])
  const client = createStripeClientDouble((call: StripeCall) => {
    if (call.method === 'POST' && call.path === '/v1/customers') {
      return { id: 'cus_new', object: 'customer' }
    }
    throw new Error(`unexpected ${call.method} ${call.path}`)
  })

  const first = await ensureCustomerForOrganization(db, client, {
    organizationId: ORG,
    email: 'owner@example.com',
    now: NOW,
  })
  assertEquals(first, { providerCustomerId: 'cus_new', created: true })
  const create = client.calls[0]!
  assertEquals(create.idempotencyKey, windowedIdempotencyKey(`customer:${ORG}`, Date.parse(NOW)))
  assertEquals(create.form, [
    [`metadata[${STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY}]`, ORG],
    ['email', 'owner@example.com'],
  ])
  // The payer row exists before Checkout is ever created, so the first
  // webhook finds its subject.
  const [row] = db.rows(payer)
  assertEquals(row?.providerCustomerId, 'cus_new')
  assertEquals(row?.organizationId, ORG)
  assertEquals(row?.userId, null)

  // A retry, or a second checkout attempt: no second customer.
  const second = await ensureCustomerForOrganization(db, client, {
    organizationId: ORG,
    email: 'owner@example.com',
    now: NOW,
  })
  assertEquals(second, { providerCustomerId: 'cus_new', created: false })
  assertEquals(client.calls.length, 1)
  assertEquals(db.rows(payer).length, 1)
})

test('the checkout key is windowed and carries the sessions it replaces, in a stable order', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z')
  const plain = checkoutIdempotencyKey('org', 'tier', 2, now)
  assertEquals(plain, windowedIdempotencyKey('checkout:org:tier:2', now))
  const after = checkoutIdempotencyKey('org', 'tier', 2, now, ['cs_b', 'cs_a'])
  assertEquals(after, windowedIdempotencyKey('checkout:org:tier:2:replaces:cs_a,cs_b', now))
  assertEquals(plain === after, false)
})

test('a session lives between 60 and 65 minutes, and every moment of one idempotency window asks for the same expiry', () => {
  const start =
    Math.floor(Date.parse('2026-10-20T12:00:00.000Z') / IDEMPOTENCY_WINDOW_MS) *
    IDEMPOTENCY_WINDOW_MS
  const expiry = checkoutSessionExpiresAtMs(start)
  assertEquals(checkoutSessionExpiresAtMs(start + IDEMPOTENCY_WINDOW_MS - 1), expiry)
  assertEquals(expiry - start, IDEMPOTENCY_WINDOW_MS + CHECKOUT_SESSION_LIFETIME_MS)
  assertEquals(
    checkoutSessionExpiresAtMs(start + IDEMPOTENCY_WINDOW_MS) - expiry,
    IDEMPOTENCY_WINDOW_MS
  )
})

test('expireCheckoutSession: expired is done, a refusal reads back expired or complete, anything else rethrows', async () => {
  const refusal = () =>
    new StripeApiError({ status: 400, type: 'invalid_request_error', message: 'not open' })
  const run = (status: string | null, expireError: StripeApiError | null) => {
    const client = createStripeClientDouble((call) => {
      if (call.method === 'POST') {
        if (expireError) throw expireError
        return { id: 'cs_1', status: 'expired' }
      }
      if (status === null) throw new Error('read failed')
      return { id: 'cs_1', status }
    })
    return { client, result: expireCheckoutSession(client, 'cs_1') }
  }
  const ok = run(null, null)
  assertEquals(await ok.result, 'expired')
  assertEquals(ok.client.calls[0]!.idempotencyKey, 'checkout-expire:cs_1')
  assertEquals(await run('expired', refusal()).result, 'expired')
  assertEquals(await run('complete', refusal()).result, 'complete')
  await assertRejects(() => run('open', refusal()).result, StripeApiError)
  await assertRejects(() => run(null, refusal()).result, StripeApiError)
  const transient = new StripeApiError({ status: 503, type: 'api_error', message: 'down' })
  const t = run('expired', transient)
  await assertRejects(() => t.result, StripeApiError)
  assertEquals(t.client.calls.length, 1)
  await assertRejects(
    () =>
      expireCheckoutSession(
        createStripeClientDouble(() => {
          throw new TypeError('x')
        }),
        'cs_1'
      ),
    TypeError
  )
})
