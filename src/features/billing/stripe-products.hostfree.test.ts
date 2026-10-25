/**
 * Stripe's product catalogue behind the gateway seam: how a Product and
 * its default Price are normalised, every reason a product cannot back a
 * tier, the request shapes the list and lookup send, and the label a
 * product suggests through its metadata.
 */

import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import { createStripeClientDouble, formOf } from '../../test-fixtures/stripe-client.ts'
import { StripeApiError } from './errors.ts'
import {
  NO_TAX_DEFAULTS,
  PRODUCT_TIER_METADATA_KEY,
  type ProviderProduct,
  type ProviderTaxDefaults,
} from './gateway.ts'
import {
  createStripeGateway,
  getStripeProduct,
  getStripeTaxDefaults,
  listStripeProducts,
  productVerificationFailures,
  summarizeStripePrice,
  summarizeStripeProduct,
  summarizeStripeTaxDefaults,
  verifyStripeProduct,
} from './stripe-products.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PRICE_S3 = {
  id: 'price_s3',
  object: 'price',
  active: true,
  type: 'recurring',
  currency: 'usd',
  unit_amount: 1000,
  recurring: { interval: 'month', interval_count: 1 },
  billing_scheme: 'per_unit',
  tax_behavior: 'exclusive',
  livemode: false,
}

const PRODUCT_S3 = {
  id: 'prod_s3',
  object: 'product',
  active: true,
  name: 'S3',
  livemode: false,
  metadata: { [PRODUCT_TIER_METADATA_KEY]: 'S3' },
  default_price: PRICE_S3,
}

const GOOD: ProviderProduct = summarizeStripeProduct(PRODUCT_S3)

function withPrice(overrides: Record<string, unknown>): ProviderProduct {
  return summarizeStripeProduct({
    ...PRODUCT_S3,
    default_price: { ...PRICE_S3, ...overrides },
  })
}

test('summarizeStripeProduct normalises a product with its expanded default price', () => {
  assertEquals(GOOD, {
    id: 'prod_s3',
    name: 'S3',
    active: true,
    livemode: false,
    metadata: { turbopanel_tier: 'S3' },
    suggestedLabel: 'S3',
    defaultPrice: {
      id: 'price_s3',
      active: true,
      type: 'recurring',
      currency: 'usd',
      unitAmount: 1000,
      interval: 'month',
      intervalCount: 1,
      billingScheme: 'per_unit',
      taxBehavior: 'exclusive',
      livemode: false,
    },
  })
})

test('an unexpanded default_price (bare id) reads as no price; a missing name falls back to the id; non-string metadata is dropped', () => {
  const bare = summarizeStripeProduct({
    ...PRODUCT_S3,
    default_price: 'price_s3',
  })
  assertEquals(bare.defaultPrice, null)
  assertEquals(summarizeStripeProduct({ ...PRODUCT_S3, default_price: null }).defaultPrice, null)
  assertEquals(summarizeStripeProduct({ id: 'prod_x', active: true }).name, 'prod_x')
  assertEquals(summarizeStripeProduct({ id: 'prod_x', active: 'yes', livemode: 1 }).active, false)
  assertEquals(summarizeStripeProduct({ id: 'prod_x', livemode: 1 }).livemode, false)
  assertEquals(
    summarizeStripeProduct({
      id: 'prod_x',
      metadata: { a: '1', b: 2, c: null },
    }).metadata,
    { a: '1' }
  )
  assertEquals(summarizeStripeProduct({ id: 'prod_x', metadata: 'nope' }).metadata, {})
  assertThrows(() => summarizeStripeProduct({ object: 'product' }), TypeError)
  assertThrows(() => summarizeStripePrice({ object: 'price' }), TypeError)
})

test('summarizeStripePrice tolerates a one-time price (no recurring block) and non-finite amounts', () => {
  const oneTime = summarizeStripePrice({
    id: 'price_once',
    active: true,
    type: 'one_time',
    currency: 'usd',
    unit_amount: 500,
  })
  assertEquals(
    [
      oneTime.type,
      oneTime.interval,
      oneTime.intervalCount,
      oneTime.billingScheme,
      oneTime.taxBehavior,
    ],
    ['one_time', null, null, null, null]
  )
  assertEquals(summarizeStripePrice({ id: 'p', unit_amount: null }).unitAmount, null)
  assertEquals(summarizeStripePrice({ id: 'p', unit_amount: '1000' }).unitAmount, null)
  assertEquals(summarizeStripePrice({ id: 'p' }).currency, '')
})

test('suggestedLabel reads the tier metadata case-insensitively and trimmed; an invalid label is null', () => {
  const suggested = (value: unknown) =>
    summarizeStripeProduct({
      id: 'prod_x',
      metadata: { [PRODUCT_TIER_METADATA_KEY]: value },
    }).suggestedLabel
  assertEquals(suggested('S3'), 'S3')
  assertEquals(suggested('s3'), 'S3')
  assertEquals(suggested('  sx '), 'SX')
  assertEquals(suggested('gold'), null)
  assertEquals(suggested('S9'), null)
  assertEquals(suggested(''), null)
  assertEquals(suggested(3), null)
  assertEquals(summarizeStripeProduct({ id: 'prod_x' }).suggestedLabel, null)
  assertEquals(
    summarizeStripeProduct({ id: 'prod_x', metadata: { tier: 'S3' } }).suggestedLabel,
    null
  )
})

test('a well-formed monthly per-unit usd price with a tax behavior verifies clean', () => {
  assertEquals(productVerificationFailures(GOOD), [])
  assertEquals(verifyStripeProduct(GOOD), {
    ok: true,
    product: GOOD,
    failures: [],
  })
  assertEquals(productVerificationFailures(withPrice({ tax_behavior: 'inclusive' })), [])
})

test('productVerificationFailures names every reason, one per check', () => {
  const only = (product: ProviderProduct) => {
    const failures = productVerificationFailures(product)
    assertEquals(failures.length, 1, failures.join(' | '))
    return failures[0]!
  }
  assertEquals(
    only(summarizeStripeProduct({ ...PRODUCT_S3, active: false })),
    'product is archived (active=false)'
  )
  assertEquals(only(withPrice({ active: false })), 'default price is archived (active=false)')
  assertEquals(only(withPrice({ type: 'one_time' })), 'default price type one_time ≠ recurring')
  assertEquals(
    only(withPrice({ recurring: { interval: 'year', interval_count: 1 } })),
    'recurring.interval year ≠ month'
  )
  assertEquals(
    only(withPrice({ recurring: { interval: 'month', interval_count: 3 } })),
    'recurring.interval_count 3 ≠ 1'
  )
  assertEquals(only(withPrice({ billing_scheme: 'tiered' })), 'billing_scheme tiered ≠ per_unit')
  assertEquals(only(withPrice({ currency: 'eur' })), 'currency eur ≠ usd')
  assertEquals(only(withPrice({ unit_amount: null })), 'default price has no unit_amount')
  const noTaxAnywhere =
    'no tax behaviour resolves for this price: it is unspecified and Stripe Tax ' +
    'carries no default. Set a default under Settings → Tax, or set tax_behavior on the price.'
  assertEquals(only(withPrice({ tax_behavior: 'unspecified' })), noTaxAnywhere)
  assertEquals(only(withPrice({ tax_behavior: undefined })), noTaxAnywhere)
  // A price with no type at all is not called out as non-recurring: the interval checks cover it.
  assertEquals(productVerificationFailures(withPrice({ type: undefined })), [])
})

test('no default price is the one failure that short-circuits the rest; other failures accumulate', () => {
  const noPrice = summarizeStripeProduct({
    ...PRODUCT_S3,
    active: false,
    default_price: null,
  })
  assertEquals(productVerificationFailures(noPrice), [
    'product is archived (active=false)',
    'product has no default price; set one in the Dashboard',
  ])
  assertEquals(
    productVerificationFailures(
      summarizeStripeProduct({ ...PRODUCT_S3, default_price: 'price_s3' })
    ),
    ['product has no default price; set one in the Dashboard']
  )
  const many = withPrice({
    active: false,
    currency: 'eur',
    recurring: { interval: 'year', interval_count: 2 },
    billing_scheme: 'tiered',
  })
  const failures = productVerificationFailures(many)
  assertEquals(failures.length, 5)
  assertEquals(verifyStripeProduct(many).ok, false)
})

test('listStripeProducts asks for every active product with its default price expanded', async () => {
  const client = createStripeClientDouble(() => ({
    object: 'list',
    data: [
      PRODUCT_S3,
      {
        ...PRODUCT_S3,
        id: 'prod_s5',
        name: 'S5',
        metadata: {},
      },
    ],
  }))
  const products = await listStripeProducts(client)
  assertEquals(
    products.map((p) => [p.id, p.suggestedLabel]),
    [
      ['prod_s3', 'S3'],
      ['prod_s5', null],
    ]
  )
  assertEquals(client.calls.length, 1)
  const [call] = client.calls
  assertEquals([call?.method, call?.path, call?.idempotencyKey], ['GET', '/v1/products', null])
  assertEquals(formOf(call!, 'active'), 'true')
  assertEquals(
    call?.form.some(([key, value]) => key.startsWith('expand[') && value === 'data.default_price'),
    true
  )
  // A bare array from the double's listAll is accepted too.
  const bare = createStripeClientDouble(() => [PRODUCT_S3])
  assertEquals((await listStripeProducts(bare)).length, 1)
})

test('getStripeProduct fetches one product by id with the default price expanded, encoding the id', async () => {
  const client = createStripeClientDouble((call) => {
    if (call.path === '/v1/products/prod_s3') return PRODUCT_S3
    if (call.path === `/v1/products/${encodeURIComponent('prod/odd id')}`) {
      return { ...PRODUCT_S3, id: 'prod/odd id' }
    }
    throw new Error(`unexpected ${call.path}`)
  })
  const product = await getStripeProduct(client, 'prod_s3')
  assertEquals(product.id, 'prod_s3')
  const [call] = client.calls
  assertEquals([call?.method, call?.path], ['GET', '/v1/products/prod_s3'])
  assertEquals(
    call?.form.some(([key, value]) => key.startsWith('expand[') && value === 'default_price'),
    true
  )
  assertEquals(
    call?.form.some(([key]) => key === 'active'),
    false
  )
  assertEquals((await getStripeProduct(client, 'prod/odd id')).id, 'prod/odd id')
})

test('createStripeGateway is the stripe provider and routes each method to the client', async () => {
  const client = createStripeClientDouble((call) =>
    call.path === '/v1/products' ? [PRODUCT_S3] : PRODUCT_S3
  )
  const gateway = createStripeGateway(client)
  assertEquals(gateway.id, 'stripe')
  assertEquals(
    (await gateway.listProducts()).map((p) => p.id),
    ['prod_s3']
  )
  assertEquals((await gateway.getProduct('prod_s3')).id, 'prod_s3')
  assertEquals(gateway.verifyProduct(GOOD, NO_TAX_DEFAULTS).ok, true)
  assertEquals(
    client.calls.map((call) => call.path),
    ['/v1/products', '/v1/products/prod_s3']
  )
})

test('verifyStripeProduct with an expected ladder entry refuses a mismatched label or list price', () => {
  assertEquals(
    verifyStripeProduct(GOOD, NO_TAX_DEFAULTS, {
      label: 'S3',
      listPriceCents: 1000,
    }).ok,
    true
  )
  assertEquals(
    verifyStripeProduct(GOOD, NO_TAX_DEFAULTS, {
      label: 'S5',
      listPriceCents: 1000,
    }).failures,
    ['turbopanel_tier metadata S3 ≠ S5']
  )
  assertEquals(
    verifyStripeProduct(GOOD, NO_TAX_DEFAULTS, {
      label: 'S3',
      listPriceCents: 999,
    }).failures,
    ['default price unit_amount 1000 ≠ 999']
  )
})

// --- account tax defaults -------------------------------------------------
// Stripe documents a price's tax_behavior as "only required if a default tax
// behavior was not provided in the Stripe Tax settings". The Dashboard shows
// that state as "Use default (no)", which reads as configured but comes back
// from the API as `unspecified` — so verification has to consult both.

/** What a successful lookup returns for `taxBehavior`. */
function accountDefault(taxBehavior: string): ProviderTaxDefaults {
  return { outcome: 'set', taxBehavior, status: 'active', error: null }
}

const ACCOUNT_EXCLUSIVE = accountDefault('exclusive')

test('an unspecified price passes when the account sets a default tax behaviour', () => {
  const unspecified = withPrice({ tax_behavior: 'unspecified' })
  assertEquals(productVerificationFailures(unspecified, ACCOUNT_EXCLUSIVE), [])
  assertEquals(productVerificationFailures(unspecified, accountDefault('inclusive')), [])
  assertEquals(verifyStripeProduct(unspecified, ACCOUNT_EXCLUSIVE).ok, true)
  // A price that speaks for itself never needs the account default.
  assertEquals(productVerificationFailures(GOOD, NO_TAX_DEFAULTS), [])
})

test("an unspecified price passes under the account's Automatic (inferred_by_currency) default", () => {
  const unspecified = withPrice({ tax_behavior: 'unspecified' })
  const automatic = accountDefault('inferred_by_currency')
  assertEquals(productVerificationFailures(unspecified, automatic), [])
  assertEquals(verifyStripeProduct(unspecified, automatic).ok, true)
  assertEquals(productVerificationFailures(unspecified, NO_TAX_DEFAULTS).length, 1)
  assertEquals(productVerificationFailures(GOOD, automatic), [])
})

test('an unspecified price still fails when the account names no default either', () => {
  const unspecified = withPrice({ tax_behavior: 'unspecified' })
  for (const defaults of [
    NO_TAX_DEFAULTS,
    accountDefault('unspecified'),
    { outcome: 'unset', taxBehavior: null, status: 'active', error: null } as const,
  ]) {
    const failures = productVerificationFailures(unspecified, defaults)
    assertEquals(failures.length, 1, failures.join(' | '))
    assertEquals(failures[0]?.includes('Settings → Tax'), true)
  }
  // Omitting the argument is the strict reading, never the lax one.
  assertEquals(productVerificationFailures(unspecified).length, 1)
})

test('an unspecified price names the real reason when the default could not be read', () => {
  const unspecified = withPrice({ tax_behavior: 'unspecified' })
  const refused = (outcome: 'permission_missing' | 'provider_error', status: number) =>
    productVerificationFailures(unspecified, {
      outcome,
      taxBehavior: null,
      status: null,
      error: { status, type: 'invalid_request_error', code: null, permission: null },
    })
  const permission = refused('permission_missing', 403)
  assertEquals(permission.length, 1)
  assertEquals(permission[0]?.includes('lacks permission to read tax settings'), true)
  assertEquals(permission[0]?.includes('carries no default'), false)
  const failed = refused('provider_error', 500)
  assertEquals(failed.length, 1)
  assertEquals(failed[0]?.includes('Stripe did not answer'), true)
  assertEquals(failed[0]?.includes('status 500'), true)
  assertEquals(failed[0]?.includes('carries no default'), false)
})

test('summarizeStripeTaxDefaults reads the defaults block and tolerates a bare object', () => {
  assertEquals(
    summarizeStripeTaxDefaults({
      status: 'active',
      defaults: { tax_behavior: 'exclusive' },
    }),
    { outcome: 'set', taxBehavior: 'exclusive', status: 'active', error: null }
  )
  // Automatic is a real default, not an absent one.
  assertEquals(
    summarizeStripeTaxDefaults({
      status: 'active',
      defaults: { tax_behavior: 'inferred_by_currency' },
    }),
    { outcome: 'set', taxBehavior: 'inferred_by_currency', status: 'active', error: null }
  )
  // Stripe's own example returns a null behaviour under an active account.
  assertEquals(
    summarizeStripeTaxDefaults({
      status: 'active',
      defaults: { tax_behavior: null },
    }),
    { outcome: 'unset', taxBehavior: null, status: 'active', error: null }
  )
  assertEquals(summarizeStripeTaxDefaults({}), {
    outcome: 'unset',
    taxBehavior: null,
    status: null,
    error: null,
  })
})

test('getStripeTaxDefaults reads /v1/tax/settings', async () => {
  const client = createStripeClientDouble(() => ({
    status: 'active',
    defaults: { tax_behavior: 'exclusive' },
  }))
  assertEquals(await getStripeTaxDefaults(client), {
    outcome: 'set',
    taxBehavior: 'exclusive',
    status: 'active',
    error: null,
  })
  assertEquals(
    client.calls.map((call) => call.path),
    ['/v1/tax/settings']
  )
})

/** What `getStripeTaxDefaults` returns when Stripe refuses with `init`. */
function refusedWith(init: ConstructorParameters<typeof StripeApiError>[0]) {
  return getStripeTaxDefaults(
    createStripeClientDouble(() => {
      throw new StripeApiError(init)
    })
  )
}

test('a restricted key without the tax settings permission reads as permission_missing, never "no default"', async () => {
  assertEquals(
    await refusedWith({
      status: 403,
      type: 'invalid_request_error',
      message:
        "The provided key 'rk_test_********wxyz' does not have the required permissions for this " +
        "endpoint. Having the 'rak_tax_settings_read' permission would allow this request to continue.",
    }),
    {
      outcome: 'permission_missing',
      taxBehavior: null,
      status: null,
      error: {
        status: 403,
        type: 'invalid_request_error',
        code: null,
        permission: 'rak_tax_settings_read',
      },
    }
  )
  // A 403 that names no permission is still a permission problem.
  const bare = await refusedWith({ status: 403, type: 'invalid_request_error', message: 'no' })
  assertEquals([bare.outcome, bare.error?.permission], ['permission_missing', null])
})

test('Stripe Tax not activated reads as unset, carrying the code', async () => {
  const result = await refusedWith({
    status: 400,
    type: 'invalid_request_error',
    code: 'stripe_tax_inactive',
    message: 'Stripe Tax has not been activated on your account.',
  })
  assertEquals(result.outcome, 'unset')
  assertEquals(result.taxBehavior, null)
  assertEquals(result.error?.code, 'stripe_tax_inactive')
})

test('any other Stripe failure reads as provider_error with its typed fields', async () => {
  for (const init of [
    { status: 500, type: 'api_error' as const, message: 'boom' },
    { status: 401, type: 'authentication_error' as const, message: 'bad key' },
    { status: 429, type: 'invalid_request_error' as const, code: 'rate_limit', message: 'slow' },
  ]) {
    const result = await refusedWith(init)
    assertEquals(result.outcome, 'provider_error', init.message)
    assertEquals(result.taxBehavior, null)
    assertEquals(result.error?.status, init.status)
    assertEquals(result.error?.type, init.type)
  }
})

test('a non-Stripe failure still propagates', async () => {
  const client = createStripeClientDouble(() => {
    throw new TypeError('bug')
  })
  await assertRejects(() => getStripeTaxDefaults(client), TypeError)
})

test('the gateway exposes the account tax defaults', async () => {
  const client = createStripeClientDouble(() => ({
    status: 'active',
    defaults: { tax_behavior: 'exclusive' },
  }))
  assertEquals(await createStripeGateway(client).getTaxDefaults(), {
    outcome: 'set',
    taxBehavior: 'exclusive',
    status: 'active',
    error: null,
  })
})
