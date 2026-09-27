/**
 * Host-free coverage for the billing client surface: `503` without a key,
 * owner-only, `409` while the subscription is delinquent, `409` while the
 * quantity lease is held, the Postgres-only reads, and the bodies each
 * mutation route parses before it forwards to `mutations.ts`.
 *
 * Checkout and the preview resolve a tier's price through the gateway —
 * the product's default price, never anything on the row — so the client
 * double answers `GET /v1/products/:id` and the tests pin what the
 * session or preview was sent.
 */

import { assertEquals } from '@std/assert'
import { stub } from '@std/testing/mock'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import type { BillingConfig } from '../../features/billing/config.ts'
import { StripeApiError } from '../../features/billing/errors.ts'
import {
  emptyLedger,
  newDeferredIntent,
  withIntent,
} from '../../features/billing/pending-changes.ts'
import type { OrganizationBillingState } from '../../features/billing/billing-records.ts'
import { payer, setting, tier } from '../../db/schema.ts'
import type { TierRow } from '../../features/tiers/tier-records.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createStripeClientDouble,
  formOf,
  type StripeCall,
} from '../../test-fixtures/stripe-client.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { windowedIdempotencyKey } from '../../features/billing/idempotency.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { SERVER_SIZE_COMMAND } from '../../features/tiers/size-command.ts'
import {
  type BillingOrgView,
  formatEndsOn,
  licenseExhaustionMessage,
  LICENSES_ENDING_ERROR,
  licensesEndingRefusal,
  NO_LICENSES_ENDING_ERROR,
  summarizeLicenses,
  summarizeTiers,
} from './routes-helpers.ts'
import { registerBillingRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '33333333-3333-4333-8333-333333333333'
const S3 = '33333333-3333-4333-8333-333333333331'
const S5 = '55555555-5555-4555-8555-555555555555'
const SRV = '66666666-6666-4666-8666-666666666666'
const NOW = '2026-09-07T12:00:00.000Z'
const PERIOD_END = '2026-10-01T00:00:00.000Z'
const CONFIG: BillingConfig = {
  secretKey: 'sk_test_x',
  webhookSigningSecret: 'whsec_x',
  apiVersion: '2025-08-27.basil',
}
const BASE_URL = 'https://panel.example.com'

/** A `tier` row: a label bound to a product, plus a cached display price the gateway may refresh. */
function tierRow(id: string, label: 'S3' | 'S5', rank: number): TierRow {
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    label,
    rank,
    provider: 'stripe',
    providerProductId: `prod_${label.toLowerCase()}`,
    priceCents: 1000 * rank,
    currency: 'usd',
    isCustom: false,
    isActive: true,
  }
}

const RANK_BY_TIER: Record<string, number> = { [S3]: 3, [S5]: 5 }
const LABEL_BY_TIER: Record<string, string> = { [S3]: 'S3', [S5]: 'S5' }

/** The Stripe Product with its default price expanded; the price id is nowhere on the row. */
function stripeProduct(label: string) {
  const key = label.toLowerCase()
  return {
    id: `prod_${key}`,
    object: 'product',
    active: true,
    name: label,
    metadata: { turbopanel_tier: label },
    default_price: {
      id: `price_${key}_live`,
      object: 'price',
      active: true,
      type: 'recurring',
      currency: 'usd',
      unit_amount: 1234,
      recurring: { interval: 'month', interval_count: 1 },
      billing_scheme: 'per_unit',
      tax_behavior: 'exclusive',
      livemode: false,
    },
  }
}

function stateWith(
  status: string | null,
  seats: { tierId: string; quantity: number }[]
): OrganizationBillingState {
  const payerRow = {
    id: 'p',
    organizationId: ORG,
    userId: null,
    provider: 'stripe',
    providerCustomerId: 'cus_1',
    taxId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
  if (!status) {
    return { payer: payerRow, subscription: null, seats: [], grant: null }
  }
  return {
    payer: payerRow,
    grant: null,
    subscription: {
      id: 's',
      payerId: 'p',
      providerSubscriptionId: 'sub_1',
      providerStatus: 'active',
      status,
      currentPeriodEnd: PERIOD_END,
      scheduleId: null,
      graceExpiresAt: null,
      pastDueSince: status === 'past_due' ? NOW : null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    seats: seats.map((seat, index) => ({
      seatId: `seat-${index}`,
      tierId: seat.tierId,
      providerItemId: `si_${index}`,
      providerPriceId: `price_${LABEL_BY_TIER[seat.tierId]!.toLowerCase()}`,
      quantity: seat.quantity,
      tier: {
        label: LABEL_BY_TIER[seat.tierId]!,
        rank: RANK_BY_TIER[seat.tierId]!,
        priceCents: 1000 * RANK_BY_TIER[seat.tierId]!,
        currency: 'usd',
        providerProductId: `prod_${LABEL_BY_TIER[seat.tierId]!.toLowerCase()}`,
        isActive: true,
      },
    })),
  }
}

function viewWith(
  state: OrganizationBillingState,
  extra: Partial<Omit<BillingOrgView, 'state'>> = {}
): BillingOrgView {
  return {
    state,
    licenses: extra.licenses ?? { active: 0, bound: 0 },
    servers: extra.servers ?? [],
    ledger: extra.ledger ?? emptyLedger(state.subscription?.providerSubscriptionId ?? ''),
  }
}

type Route = `${StripeCall['method']} ${string}`

type HarnessOpts = {
  config?: BillingConfig | null
  ownAllowed?: boolean
  view?: BillingOrgView
  leaseHeld?: boolean
  /** Extra Stripe routes; the product catalogue is always answered. */
  routes?: Partial<Record<Route, (call: StripeCall) => unknown>>
}

async function buildApp(opts: HarnessOpts = {}) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const email = `billing-${crypto.randomUUID()}@example.com`
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: ORG, name: 'Billing Org' })
  const authDb = Object.assign(createMockAuthDb(state), {
    execute: () => Promise.resolve([{ allowed: opts.ownAllowed !== false }]),
  }) as unknown as Db
  // The catalogue, the payer Checkout looks up, and the `setting` rows the
  // ledger, the seat-increase record and the public-URL lookup read.
  const db = createMemoryDb(
    [
      [tier, [tierRow(S3, 'S3', 3), tierRow(S5, 'S5', 5)]],
      [
        payer,
        [
          {
            id: 'p',
            organizationId: ORG,
            userId: null,
            provider: 'stripe',
            providerCustomerId: 'cus_1',
            taxId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      ],
      [setting, []],
    ],
    { fallback: authDb }
  )
  const client = createStripeClientDouble((call) => {
    const handler = opts.routes?.[`${call.method} ${call.path}` as Route]
    if (handler) return handler(call)
    if (call.method === 'GET' && call.path === '/v1/products/prod_s3') {
      return stripeProduct('S3')
    }
    if (call.method === 'GET' && call.path === '/v1/products/prod_s5') {
      return stripeProduct('S5')
    }
    throw new Error(`unexpected stripe call ${call.method} ${call.path}`)
  })
  const leases: string[] = []
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    const config = opts.config === undefined ? CONFIG : opts.config
    if (config) c.set('billingConfig', config)
    return next()
  })
  // Billing is hosted-only; the aggregator never mounts this router on Deno.
  registerBillingRoutes(
    app,
    {
      secrets,
      runtime: 'workers',
      signupEnvOverride: undefined,
      baseUrl: BASE_URL,
    },
    {
      createClient: () => client,
      loadView: () =>
        Promise.resolve(opts.view ?? viewWith(stateWith('active', [{ tierId: S3, quantity: 2 }]))),
      beginMutation: () => {
        leases.push('begin')
        return Promise.resolve(opts.leaseHeld ? null : { organizationId: ORG, owner: 'me' })
      },
      endMutation: () => {
        leases.push('end')
        return Promise.resolve()
      },
      nowMs: () => Date.parse(NOW),
    }
  )
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const headers = {
    Cookie: cookie,
    [ORG_ID_HEADER]: ORG,
    'content-type': 'application/json',
  }
  const stripeCalls = () => client.calls.map((c) => `${c.method} ${c.path}`)
  return { app, headers, db, client, stripeCalls, leases }
}

const PATHS = [
  ['GET', '/billing/catalog'],
  ['GET', '/billing/subscription'],
  ['POST', '/billing/checkout'],
  ['POST', '/billing/portal'],
  ['POST', '/billing/preview'],
  ['POST', '/billing/seats'],
  ['POST', '/billing/restore'],
  ['POST', '/billing/upgrade'],
  ['POST', '/billing/downgrade'],
] as const

test('every billing route is 401 without a session', async () => {
  const { app } = await buildApp()
  for (const [method, path] of PATHS) {
    const res = await app.request(path, { method })
    assertEquals(res.status, 401, `${method} ${path}`)
  }
})

test('every billing route is 503 billing_not_configured when the instance has no key — self-hosted has no billing surface', async () => {
  const { app, headers, stripeCalls } = await buildApp({ config: null })
  for (const [method, path] of PATHS) {
    const res = await app.request(path, {
      method,
      headers,
      body: method === 'POST' ? '{}' : undefined,
    })
    assertEquals(res.status, 503, `${method} ${path}`)
    assertEquals(await res.json(), { error: 'billing_not_configured' })
  }
  assertEquals(stripeCalls(), [])
})

test('every billing route is 503 billing_not_configured when only the Stripe API key is set', async () => {
  const { app, headers, stripeCalls } = await buildApp({
    config: {
      secretKey: 'sk_test_x',
      webhookSigningSecret: null,
      apiVersion: '2025-08-27.basil',
    },
  })
  for (const [method, path] of PATHS) {
    const res = await app.request(path, {
      method,
      headers,
      body: method === 'POST' ? '{}' : undefined,
    })
    assertEquals(res.status, 503, `${method} ${path}`)
    assertEquals(await res.json(), { error: 'billing_not_configured' })
  }
  assertEquals(stripeCalls(), [])
})

test('billing routes are owner-only', async () => {
  const { app, headers } = await buildApp({ ownAllowed: false })
  const res = await app.request('/billing/catalog', { headers })
  assertEquals(res.status, 403)
})

test("GET /billing/catalog lists active tiers from Postgres in ladder order with the ladder's entitlements, no Stripe call", async () => {
  const { app, headers, stripeCalls } = await buildApp()
  const res = await app.request('/billing/catalog', { headers })
  assertEquals(res.status, 200)
  const body = (await res.json()) as {
    tiers: {
      id: string
      label: string
      rank: number
      priceCents: number
      currency: string
      isCustom: boolean
      entitlements: Record<string, number>
    }[]
  }
  assertEquals(
    body.tiers.map((t) => [t.id, t.label, t.rank, t.priceCents, t.currency, t.isCustom]),
    [
      [S3, 'S3', 3, 3000, 'usd', false],
      [S5, 'S5', 5, 5000, 'usd', false],
    ]
  )
  // Entitlements come from the in-code ladder, not from any column.
  assertEquals(body.tiers[0]!.entitlements, {
    maxCores: 16,
    maxMemoryBytes: 64 * 1024 ** 3,
    nicSlots: 5,
    driveSlots: 6,
    gpuSlots: 2,
    filesystemSlots: 9,
  })
  assertEquals(body.tiers[1]!.entitlements.maxCores, 64)
  // The size one-liner Add Server shows rides on the catalogue.
  assertEquals((body as unknown as { sizeCommand: string }).sizeCommand, SERVER_SIZE_COMMAND)
  assertEquals(stripeCalls(), [])
})

test('GET /billing/subscription summarises the projection: payer, subscription, tiers, licenses net of releases, servers, pending changes', async () => {
  const intent = newDeferredIntent('release-seat', {
    fromTierId: S3,
    toTierId: null,
    landsAt: PERIOD_END,
    fromQuantity: 3,
    nowMs: Date.parse(NOW),
  })
  const view = viewWith(stateWith('past_due', [{ tierId: S3, quantity: 3 }]), {
    licenses: { active: 1, bound: 1 },
    servers: [
      {
        serverId: SRV,
        boundAt: NOW,
        requiredRank: 3,
        assignedTierId: S3,
      },
    ],
    ledger: withIntent(emptyLedger('sub_1'), intent),
  })
  assertEquals(summarizeTiers(view)[0]?.releasing, 1)
  assertEquals(summarizeLicenses(view), {
    purchased: 3,
    granted: 0,
    releasing: 1,
    ending: 1,
    endsAt: PERIOD_END,
    held: 1,
    inUse: 1,
    bound: 1,
    provisioning: 0,
    unusedKeys: 0,
    available: 1,
  })
  const { app, headers, stripeCalls } = await buildApp({ view })
  const res = await app.request('/billing/subscription', { headers })
  assertEquals(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assertEquals(Object.keys(body).sort(), [
    'licenses',
    'payer',
    'pendingChanges',
    'servers',
    'subscription',
    'tiers',
  ])
  assertEquals(body.payer, { taxId: null })
  assertEquals(body.subscription, {
    status: 'past_due',
    currentPeriodEnd: PERIOD_END,
    pastDueSince: NOW,
    graceExpiresAt: null,
    scheduleAttached: false,
  })
  assertEquals(body.tiers, [
    {
      tierId: S3,
      label: 'S3',
      rank: 3,
      purchased: 3,
      inUse: 1,
      ending: 1,
      endsAt: PERIOD_END,
      available: 1,
      releasing: 1,
      priceCents: 3000,
      currency: 'usd',
    },
  ])
  assertEquals(body.licenses, {
    purchased: 3,
    releasing: 1,
    ending: 1,
    endsAt: PERIOD_END,
    held: 1,
    inUse: 1,
    bound: 1,
    provisioning: 0,
    unusedKeys: 0,
    available: 1,
  })
  assertEquals(body.servers, [
    {
      serverId: SRV,
      assignedTierId: S3,
      requiredTier: 'S3',
    },
  ])
  assertEquals(body.pendingChanges, [
    {
      id: intent.id,
      kind: 'release-seat',
      fromTierId: S3,
      toTierId: null,
      createdAt: NOW,
      landsAt: PERIOD_END,
    },
  ])
  assertEquals(stripeCalls(), [])
})

test('Add Server and the billing page agree: an unused registration key makes the last license unavailable everywhere', () => {
  // The owner's screen (2026-09-27): 6 purchased at one tier, 5 servers on
  // it, 1 registration key minted and never used.
  const servers = Array.from({ length: 5 }, (_, i) => ({
    serverId: `srv-${i}`,
    boundAt: NOW,
    requiredRank: 3,
    assignedTierId: S3,
  }))
  const view = viewWith(stateWith('active', [{ tierId: S3, quantity: 6 }]), {
    licenses: { active: 6, bound: 5 },
    servers,
  })
  const licenses = summarizeLicenses(view)
  assertEquals(
    [licenses.available, licenses.inUse, licenses.unusedKeys, licenses.provisioning],
    [0, 5, 1, 0]
  )
  // The tier row can no longer say "1 free" while the mint gate refuses.
  assertEquals(summarizeTiers(view)[0]?.available, 0)
  assertEquals(
    licenseExhaustionMessage(licenses),
    '5 in use, 1 held by an unused registration key — delete it or use it to add this server.'
  )
})

test('a key whose server is being provisioned is in use, not unused and not free', () => {
  // Same screen, corrected: the "unused" key belongs to a server whose
  // daemon has already tried to enrol.
  const servers = Array.from({ length: 5 }, (_, i) => ({
    serverId: `srv-${i}`,
    boundAt: NOW,
    requiredRank: 3,
    assignedTierId: S3,
  }))
  const view = viewWith(stateWith('active', [{ tierId: S3, quantity: 6 }]), {
    licenses: { active: 6, bound: 5, provisioning: 1 },
    servers,
  })
  const licenses = summarizeLicenses(view)
  assertEquals(
    [licenses.available, licenses.inUse, licenses.unusedKeys, licenses.provisioning],
    [0, 6, 0, 1]
  )
  assertEquals(summarizeTiers(view)[0]?.available, 0)
  assertEquals(
    licenseExhaustionMessage(licenses),
    'All 6 licenses are in use (1 provisioning) — buy another to add this server.'
  )
})

test('ending licenses, an unused key and a provisioning server are each named, cheapest way out first', () => {
  const intents = [0, 1, 2].map(() =>
    newDeferredIntent('release-seat', {
      fromTierId: S3,
      toTierId: null,
      landsAt: '2026-10-26T00:00:00.000Z',
      fromQuantity: 6,
      nowMs: Date.parse(NOW),
    })
  )
  let ledger = emptyLedger('sub_1')
  for (const intent of intents) ledger = withIntent(ledger, intent)
  const view = viewWith(stateWith('active', [{ tierId: S3, quantity: 6 }]), {
    licenses: { active: 3, bound: 1, provisioning: 1 },
    servers: [{ serverId: SRV, boundAt: NOW, requiredRank: 3, assignedTierId: S3 }],
    ledger,
  })
  const licenses = summarizeLicenses(view)
  assertEquals([licenses.available, licenses.unusedKeys, licenses.ending], [0, 1, 3])
  assertEquals(
    licenseExhaustionMessage(licenses),
    '2 in use (1 provisioning), 1 held by an unused registration key, 3 end Oct 26 — use or delete the unused key, or restore one, to add this server.'
  )
  // A key can be provisioning only while it is active and unbound: a
  // stale-high count is clamped.
  const clamped = summarizeLicenses(
    viewWith(stateWith('active', [{ tierId: S3, quantity: 2 }]), {
      licenses: { active: 1, bound: 1, provisioning: 4 },
    })
  )
  assertEquals([clamped.provisioning, clamped.unusedKeys, clamped.inUse], [0, 0, 1])
})

test('the exhaustion sentence never calls an ending license "in use" and names the way out', () => {
  const base = {
    purchased: 6,
    releasing: 3,
    held: 3,
    bound: 3,
    provisioning: 0,
    ending: 3,
    endsAt: '2026-10-26T00:00:00.000Z',
  }
  assertEquals(
    licenseExhaustionMessage(base),
    '3 in use, 3 end Oct 26 — restore one to add this server.'
  )
  assertEquals(
    licenseExhaustionMessage({ ...base, purchased: 4, releasing: 1, ending: 1, endsAt: null }),
    '3 in use, 1 ends at the end of the billing period — restore one to add this server.'
  )
  const none = { releasing: 0, provisioning: 0, ending: 0, endsAt: null }
  assertEquals(
    licenseExhaustionMessage({ ...none, purchased: 3, held: 3, bound: 3 }),
    'All 3 licenses are in use — buy another to add this server.'
  )
  assertEquals(
    licenseExhaustionMessage({ ...none, purchased: 1, held: 1, bound: 1 }),
    'Your only license is in use — buy another to add this server.'
  )
  assertEquals(
    licenseExhaustionMessage({ ...none, purchased: 0, held: 0, bound: 0 }),
    'No licenses yet — buy one to add this server.'
  )
  // Only a downgrade holds the last one back: it is changing tier, not ending and not in use.
  assertEquals(
    licenseExhaustionMessage({ ...none, purchased: 2, releasing: 1, held: 1, bound: 1 }),
    '1 in use, 1 changing tier at the end of the billing period — buy another to add this server now.'
  )
  // The boundary is a UTC instant: formatted in UTC, whatever the host zone.
  assertEquals(formatEndsOn('2026-10-01T00:00:00.000Z'), 'Oct 1')
  assertEquals(formatEndsOn(null), null)
  assertEquals(formatEndsOn('not a date'), null)
})

test('licensesEndingRefusal is per tier: only release-seat intents at that tier refuse', () => {
  const ledger = withIntent(
    withIntent(
      emptyLedger('sub_1'),
      newDeferredIntent('release-seat', {
        fromTierId: S3,
        toTierId: null,
        landsAt: PERIOD_END,
        fromQuantity: 2,
        nowMs: Date.parse(NOW),
      })
    ),
    newDeferredIntent('downgrade', {
      fromTierId: S5,
      toTierId: S3,
      landsAt: PERIOD_END,
      fromQuantity: 1,
      nowMs: Date.parse(NOW),
    })
  )
  assertEquals(licensesEndingRefusal(ledger, S3), {
    error: LICENSES_ENDING_ERROR,
    tierId: S3,
    ending: 1,
    endsAt: PERIOD_END,
  })
  // S5's only intent is a downgrade: nothing there is ending.
  assertEquals(licensesEndingRefusal(ledger, S5), null)
})

test('entitlement-raising routes answer 409 subscription_past_due while delinquent, before any Stripe call', async () => {
  const view = viewWith(stateWith('past_due', [{ tierId: S3, quantity: 2 }]))
  const { app, headers, stripeCalls } = await buildApp({ view })
  for (const [path, body] of [
    ['/billing/preview', { tierId: S3, delta: 1 }],
    ['/billing/seats', { tierId: S3, delta: 1 }],
    ['/billing/upgrade', { fromTierId: S3, toTierId: S5 }],
  ] as const) {
    const res = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    assertEquals(res.status, 409, path)
    assertEquals(((await res.json()) as { error: string }).error, 'subscription_past_due', path)
  }
  assertEquals(stripeCalls(), [])
})

test('mutations answer 409 billing_mutation_in_progress while the lease is held; a held lease is never released by the loser', async () => {
  const view = viewWith(stateWith(null, []))
  const { app, headers, leases, stripeCalls } = await buildApp({
    leaseHeld: true,
    view,
  })
  for (const [path, body] of [
    ['/billing/seats', { tierId: S3, delta: 1 }],
    ['/billing/checkout', { tierId: S3 }],
  ] as const) {
    const res = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    assertEquals(res.status, 409, path)
    assertEquals(await res.json(), { error: 'billing_mutation_in_progress' })
  }
  assertEquals(leases, ['begin', 'begin'])
  assertEquals(stripeCalls(), [])
})

test("POST /billing/checkout sends the product's default price from the gateway as the line item — never a price stored on the row", async () => {
  const { app, headers, db, client, stripeCalls } = await buildApp({
    view: viewWith(stateWith(null, [])),
    routes: {
      'POST /v1/checkout/sessions': () => ({
        id: 'cs_1',
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
      }),
    },
  })
  const res = await app.request('/billing/checkout', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tierId: S3, quantity: 2 }),
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    url: 'https://checkout.stripe.com/c/pay/cs_1',
    sessionId: 'cs_1',
  })
  // The product lookup precedes the session; the existing payer means no customer is created.
  assertEquals(stripeCalls(), ['GET /v1/products/prod_s3', 'POST /v1/checkout/sessions'])
  const session = client.calls[1]!
  assertEquals(formOf(session, 'mode'), 'subscription')
  assertEquals(formOf(session, 'customer'), 'cus_1')
  assertEquals(formOf(session, 'line_items[0][price]'), 'price_s3_live')
  assertEquals(formOf(session, 'line_items[0][quantity]'), '2')
  assertEquals(formOf(session, 'cancel_url'), `${BASE_URL}/${ORG}/billing?checkout=cancel`)
  assertEquals(
    session.idempotencyKey,
    windowedIdempotencyKey(`checkout:${ORG}:${S3}:2`, Date.parse(NOW))
  )
  // The row's display cache followed the product.
  assertEquals(db.rows(tier).find((row) => row.id === S3)?.priceCents, 1234)
})

test("a Stripe refusal answers 502 stripe_error with only the typed fields, and logs Stripe's reason for the operator", async () => {
  const { app, headers } = await buildApp({
    view: viewWith(stateWith(null, [])),
    routes: {
      'POST /v1/checkout/sessions': () => {
        throw new StripeApiError({
          status: 400,
          type: 'invalid_request_error',
          message: 'Stripe Tax has not been activated on your account.',
          code: 'stripe_tax_inactive',
          param: 'automatic_tax[enabled]',
          requestId: 'req_123',
        })
      },
    },
  })
  const writes: string[] = []
  const writeStub = stub(Deno.stderr, 'writeSync', (data) => {
    writes.push(new TextDecoder().decode(data))
    return data.byteLength
  })
  let res: Response
  try {
    res = await app.request('/billing/checkout', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tierId: S3, quantity: 1 }),
    })
  } finally {
    writeStub.restore()
  }
  assertEquals(res.status, 502)
  const body = await res.json()
  assertEquals(body, {
    error: 'stripe_error',
    type: 'invalid_request_error',
    code: 'stripe_tax_inactive',
    transient: false,
  })
  assertEquals(JSON.stringify(body).includes('Stripe Tax'), false)
  const line = writes.find((w) => w.includes(' ERROR billing '))
  assertEquals(line?.includes('Stripe refused POST /billing/checkout'), true)
  assertEquals(line?.includes('code=stripe_tax_inactive'), true)
  assertEquals(line?.includes('param=automatic_tax[enabled]'), true)
  assertEquals(line?.includes('request=req_123'), true)
  assertEquals(line?.includes('"Stripe Tax has not been activated on your account."'), true)
})

test('POST /billing/checkout reuses an unexpired pending session instead of minting another, and refuses a different quantity while one is pending', async () => {
  const { app, headers, stripeCalls } = await buildApp({
    view: viewWith(stateWith(null, [])),
    routes: {
      'POST /v1/checkout/sessions': () => ({
        id: 'cs_1',
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
      }),
    },
  })
  const body = JSON.stringify({ tierId: S3, quantity: 2 })
  const first = await app.request('/billing/checkout', {
    method: 'POST',
    headers,
    body,
  })
  const second = await app.request('/billing/checkout', {
    method: 'POST',
    headers,
    body,
  })
  assertEquals(first.status, 200)
  assertEquals(await first.json(), {
    url: 'https://checkout.stripe.com/c/pay/cs_1',
    sessionId: 'cs_1',
  })
  assertEquals(second.status, 200)
  assertEquals(await second.json(), {
    url: 'https://checkout.stripe.com/c/pay/cs_1',
    sessionId: 'cs_1',
  })
  assertEquals(
    stripeCalls().filter((call) => call === 'POST /v1/checkout/sessions'),
    ['POST /v1/checkout/sessions']
  )

  const other = await app.request('/billing/checkout', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tierId: S3, quantity: 3 }),
  })
  assertEquals(other.status, 409)
  assertEquals(await other.json(), { error: 'checkout_pending' })
  assertEquals(
    stripeCalls().filter((call) => call === 'POST /v1/checkout/sessions'),
    ['POST /v1/checkout/sessions']
  )
})

test('checkout is refused 409 subscription_exists once a live subscription is projected, and 400 tier_not_purchasable for a retired tier', async () => {
  const { app, headers, stripeCalls } = await buildApp()
  const exists = await app.request('/billing/checkout', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tierId: S3 }),
  })
  assertEquals(exists.status, 409)
  assertEquals(await exists.json(), { error: 'subscription_exists' })
  assertEquals(stripeCalls(), [])

  const fresh = await buildApp({ view: viewWith(stateWith(null, [])) })
  fresh.db.rows(tier).find((row) => row.id === S5)!.isActive = false
  const retired = await fresh.app.request('/billing/checkout', {
    method: 'POST',
    headers: fresh.headers,
    body: JSON.stringify({ tierId: S5 }),
  })
  assertEquals(retired.status, 400)
  assertEquals(await retired.json(), {
    error: 'tier_not_purchasable',
    reason: 'inactive',
    failures: [],
  })
  assertEquals(fresh.stripeCalls(), [])
  assertEquals(fresh.leases, ['begin', 'end'])
})

test('POST /billing/preview accepts { tierId, delta } and pins a proration date on the invoice preview', async () => {
  const { app, headers, client, stripeCalls } = await buildApp({
    routes: {
      'POST /v1/invoices/create_preview': () => ({
        object: 'invoice',
        currency: 'usd',
        subtotal: 500,
        total: 500,
        amount_due: 500,
        lines: { data: [] },
      }),
    },
  })
  const res = await app.request('/billing/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tierId: S3, delta: 1 }),
  })
  assertEquals(res.status, 200)
  const body = (await res.json()) as { prorationDate: number; total: number }
  assertEquals(body.prorationDate, Math.floor(Date.parse(NOW) / 1000))
  assertEquals(body.total, 500)
  // The tier already has an item: its price is on the seat, so no product lookup.
  assertEquals(stripeCalls(), ['POST /v1/invoices/create_preview'])
  const preview = client.calls[0]!
  assertEquals(formOf(preview, 'subscription'), 'sub_1')
  assertEquals(formOf(preview, 'subscription_details[items][0][id]'), 'si_0')
  assertEquals(formOf(preview, 'subscription_details[items][0][quantity]'), '3')
  assertEquals(
    formOf(preview, 'subscription_details[proration_date]'),
    String(Math.floor(Date.parse(NOW) / 1000))
  )
})

/** A ledger with `count` S3 licenses ending at the period boundary. */
function endingLedger(count: number) {
  let ledger = emptyLedger('sub_1')
  for (let i = 0; i < count; i += 1) {
    ledger = withIntent(
      ledger,
      newDeferredIntent('release-seat', {
        fromTierId: S3,
        toTierId: null,
        landsAt: PERIOD_END,
        fromQuantity: 6,
        nowMs: Date.parse(NOW) - (count - i) * 60_000,
      })
    )
  }
  return ledger
}

test('POST /billing/preview refuses 409 licenses_ending for an increase at a tier with licenses ending — even while past due, with no Stripe call', async () => {
  for (const status of ['active', 'past_due']) {
    const view = viewWith(stateWith(status, [{ tierId: S3, quantity: 6 }]), {
      ledger: endingLedger(3),
    })
    const { app, headers, stripeCalls } = await buildApp({ view })
    const res = await app.request('/billing/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tierId: S3, delta: 2 }),
    })
    assertEquals(res.status, 409, status)
    assertEquals(await res.json(), {
      error: LICENSES_ENDING_ERROR,
      tierId: S3,
      ending: 3,
      endsAt: PERIOD_END,
    })
    assertEquals(stripeCalls(), [], status)
  }
})

test('POST /billing/preview of a move INTO a tier with licenses ending is refused; a move out of it is quoted', async () => {
  const view = viewWith(
    stateWith('active', [
      { tierId: S3, quantity: 6 },
      { tierId: S5, quantity: 1 },
    ]),
    { ledger: endingLedger(2) }
  )
  const { app, headers, stripeCalls } = await buildApp({
    view,
    routes: {
      'POST /v1/invoices/create_preview': () => ({
        object: 'invoice',
        currency: 'usd',
        subtotal: 500,
        total: 500,
        amount_due: 500,
        lines: { data: [] },
      }),
    },
  })
  const into = await app.request('/billing/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromTierId: S5, toTierId: S3 }),
  })
  assertEquals(into.status, 409)
  assertEquals(((await into.json()) as { error: string }).error, LICENSES_ENDING_ERROR)
  assertEquals(stripeCalls(), [])

  // S3 ending never blocks adding at S5.
  const outOf = await app.request('/billing/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromTierId: S3, toTierId: S5 }),
  })
  assertEquals(outOf.status, 200)
  assertEquals(((await outOf.json()) as { total: number }).total, 500)
})

test("POST /billing/preview accepts { fromTierId, toTierId } as a −1/+1 swap, resolving the target's price through the gateway", async () => {
  const { app, headers, client, stripeCalls } = await buildApp({
    routes: {
      'POST /v1/invoices/create_preview': () => ({
        object: 'invoice',
        currency: 'usd',
        subtotal: 1234,
        total: 1234,
        amount_due: 1234,
        lines: { data: [] },
      }),
    },
  })
  const res = await app.request('/billing/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromTierId: S3, toTierId: S5 }),
  })
  assertEquals(res.status, 200)
  assertEquals(stripeCalls(), ['GET /v1/products/prod_s5', 'POST /v1/invoices/create_preview'])
  const preview = client.calls[1]!
  assertEquals(formOf(preview, 'subscription_details[items][0][id]'), 'si_0')
  assertEquals(formOf(preview, 'subscription_details[items][0][quantity]'), '1')
  assertEquals(formOf(preview, 'subscription_details[items][1][price]'), 'price_s5_live')
  assertEquals(formOf(preview, 'subscription_details[items][1][quantity]'), '1')
})

test('POST /billing/preview answers 400 on an empty body, a zero delta, half of each shape, and a bad id', async () => {
  const { app, headers, stripeCalls } = await buildApp()
  for (const body of [
    '{}',
    JSON.stringify({ tierId: S3, delta: 0 }),
    JSON.stringify({ fromTierId: S3, delta: 1 }),
    JSON.stringify({ tierId: S3, toTierId: S5 }),
    JSON.stringify({ tierId: 'nope', delta: 1 }),
    'nope',
  ]) {
    const res = await app.request('/billing/preview', {
      method: 'POST',
      headers,
      body,
    })
    assertEquals(res.status, 400, body)
    assertEquals(await res.json(), { error: 'Invalid request' }, body)
  }
  assertEquals(stripeCalls(), [])
})

test('POST /billing/seats validates the body: a tier id, a non-zero integer delta, an optional integer proration date', async () => {
  const { app, headers, leases } = await buildApp()
  for (const body of [
    '{}',
    JSON.stringify({ tierId: S3 }),
    JSON.stringify({ tierId: S3, delta: 0 }),
    JSON.stringify({ tierId: S3, delta: 1.5 }),
    JSON.stringify({ tierId: 'x', delta: 1 }),
    JSON.stringify({ tierId: S3, delta: 1, prorationDate: 'soon' }),
    'nope',
  ]) {
    const res = await app.request('/billing/seats', {
      method: 'POST',
      headers,
      body,
    })
    assertEquals(res.status, 400, body)
  }
  // Every refusal above happened before the lease.
  assertEquals(leases, [])
})

test('POST /billing/restore validates { tierId, count } before the lease', async () => {
  const { app, headers, leases } = await buildApp()
  for (const body of [
    '{}',
    JSON.stringify({ tierId: S3 }),
    JSON.stringify({ tierId: S3, count: 0 }),
    JSON.stringify({ tierId: S3, count: -2 }),
    JSON.stringify({ tierId: S3, count: 1.5 }),
    JSON.stringify({ tierId: 'x', count: 1 }),
    'nope',
  ]) {
    const res = await app.request('/billing/restore', { method: 'POST', headers, body })
    assertEquals(res.status, 400, body)
  }
  assertEquals(leases, [])
})

test('POST /billing/restore takes ending licenses back under the lease — no purchase — and answers 409 no_licenses_ending when none are', async () => {
  // Three ending, no schedule attached in the view: restoring all three
  // leaves nothing deferred, so there is nothing to tell Stripe.
  const view = viewWith(stateWith('active', [{ tierId: S3, quantity: 6 }]), {
    ledger: endingLedger(3),
  })
  const { app, headers, leases, stripeCalls } = await buildApp({ view })
  const res = await app.request('/billing/restore', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tierId: S3, count: 3 }),
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true, restored: 3, ending: 0, scheduleId: null })
  assertEquals(stripeCalls(), [])
  assertEquals(leases, ['begin', 'end'])

  const none = await buildApp()
  const refused = await none.app.request('/billing/restore', {
    method: 'POST',
    headers: none.headers,
    body: JSON.stringify({ tierId: S3, count: 1 }),
  })
  assertEquals(refused.status, 409)
  assertEquals(await refused.json(), { error: NO_LICENSES_ENDING_ERROR, tierId: S3 })
})

test('POST /billing/upgrade validates { fromTierId, toTierId } and forwards to upgradeTier, which decides the direction', async () => {
  const { app, headers, leases, stripeCalls } = await buildApp()
  for (const body of [
    '{}',
    JSON.stringify({ fromTierId: S3 }),
    JSON.stringify({ toTierId: S5 }),
    JSON.stringify({ fromTierId: 'not-a-uuid', toTierId: S5 }),
    JSON.stringify({ fromTierId: S3, toTierId: 12 }),
    JSON.stringify({ fromTierId: S3, toTierId: S5, prorationDate: 'x' }),
  ]) {
    const res = await app.request('/billing/upgrade', {
      method: 'POST',
      headers,
      body,
    })
    assertEquals(res.status, 400, body)
    assertEquals(await res.json(), { error: 'Invalid request' }, body)
  }
  // A well-formed body reaches the mutation: only it knows S5 → S3 is not an upgrade.
  const wrongWay = await app.request('/billing/upgrade', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromTierId: S5, toTierId: S3 }),
  })
  assertEquals(wrongWay.status, 400)
  assertEquals(await wrongWay.json(), { error: 'not_an_upgrade' })
  const same = await app.request('/billing/upgrade', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromTierId: S3, toTierId: S3 }),
  })
  assertEquals(same.status, 400)
  assertEquals(await same.json(), { error: 'Invalid request' })
  // The direction check runs before the lease is taken.
  assertEquals(leases, [])
  assertEquals(stripeCalls(), [])
})

test('POST /billing/downgrade validates { fromTierId, toTierId } and forwards to downgradeTier: the intent and the schedule phase come back', async () => {
  const { app, headers, leases, client, stripeCalls } = await buildApp({
    view: viewWith(stateWith('active', [{ tierId: S5, quantity: 1 }])),
    routes: {
      'POST /v1/subscription_schedules': () => ({
        id: 'sub_sched_1',
        object: 'subscription_schedule',
        status: 'active',
        subscription: 'sub_1',
        phases: [
          {
            start_date: 1_700_000_000,
            end_date: 1_702_592_000,
            items: [{ price: 'price_s5', quantity: 1 }],
          },
        ],
      }),
      'POST /v1/subscription_schedules/sub_sched_1': () => ({
        id: 'sub_sched_1',
        object: 'subscription_schedule',
        status: 'active',
        phases: [],
      }),
    },
  })
  for (const body of [
    '{}',
    JSON.stringify({ fromTierId: S5 }),
    JSON.stringify({ fromTierId: 'bad', toTierId: S3 }),
  ]) {
    const res = await app.request('/billing/downgrade', {
      method: 'POST',
      headers,
      body,
    })
    assertEquals(res.status, 400, body)
    assertEquals(await res.json(), { error: 'Invalid request' }, body)
  }
  const wrongWay = await app.request('/billing/downgrade', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromTierId: S3, toTierId: S5 }),
  })
  assertEquals(wrongWay.status, 400)
  assertEquals(await wrongWay.json(), { error: 'not_a_downgrade' })
  assertEquals(leases, [])

  const res = await app.request('/billing/downgrade', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromTierId: S5, toTierId: S3 }),
  })
  assertEquals(res.status, 200)
  const body = (await res.json()) as {
    ok: boolean
    deferred: boolean
    intentId: string
    scheduleId: string
  }
  assertEquals([body.ok, body.deferred, body.scheduleId], [true, true, 'sub_sched_1'])
  assertEquals(typeof body.intentId, 'string')
  // The target's price from the gateway, then the schedule; the future phase holds the target at that price.
  assertEquals(stripeCalls(), [
    'GET /v1/products/prod_s3',
    'POST /v1/subscription_schedules',
    'POST /v1/subscription_schedules/sub_sched_1',
  ])
  assertEquals(formOf(client.calls[2]!, 'phases[1][items][0][price]'), 'price_s3_live')
  assertEquals(formOf(client.calls[2]!, 'phases[1][items][0][quantity]'), '1')
  assertEquals(leases, ['begin', 'end'])
})

test('POST /billing/portal is 404 for an organization with no projected payer, before any Stripe call', async () => {
  const view = viewWith({
    payer: null,
    subscription: null,
    seats: [],
    grant: null,
  })
  const { app, headers, stripeCalls } = await buildApp({ view })
  const res = await app.request('/billing/portal', { method: 'POST', headers })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
  assertEquals(stripeCalls(), [])
})
