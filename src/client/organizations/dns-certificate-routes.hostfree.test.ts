/**
 * Every DNS certificate route needs a session on both editions. An uploaded
 * panel-managed row says it will not renew from the control plane; a row
 * ordered through a server shows its renewal and retry times.
 */
import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { tls } from '../../db/schema.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import {
  NO_RENEWAL_MESSAGE,
  registerOrganizationDnsCertificateRoutes,
  toApiDnsCertificate,
} from './dns-certificate-routes.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

const orgId = '11111111-1111-4111-8111-111111111111'
const tlsId = '22222222-2222-4222-8222-222222222222'
const ORDER_PATHS = [
  `/organizations/${orgId}/dns-certificates`,
  `/organizations/${orgId}/dns-certificates/${tlsId}/check`,
  `/organizations/${orgId}/dns-certificates/${tlsId}/retry`,
]

async function buildApp(runtime: 'deno' | 'workers') {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const email = 'dns-certificates@example.com'
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, { sessionId: crypto.randomUUID(), userId, email, role: 'user' })
  seedMockUser(state, { id: userId, email, isDisabled: false, isEmailVerified: true, role: 'user' })
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', createMockAuthDb(state))
    return next()
  })
  registerOrganizationDnsCertificateRoutes(app, {
    secrets,
    runtime,
    signupEnvOverride: undefined,
  })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return { app, cookie }
}

for (const runtime of ['deno', 'workers'] as const) {
  test(`${runtime}: every route still needs a session`, async () => {
    const { app } = await buildApp(runtime)
    for (const path of ORDER_PATHS) {
      assertEquals((await app.request(path, { method: 'POST' })).status, 401, path)
    }
    assertEquals((await app.request(ORDER_PATHS[0]!)).status, 401)
  })
}

function row(acme: Record<string, unknown>): typeof tls.$inferSelect {
  return {
    id: tlsId,
    organizationId: orgId,
    status: 'ready',
    notAfter: '2027-01-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    metadata: {
      dnsNames: ['a.example.com'],
      issuer: 'Test Issuer',
      acme: { managedBy: 'panel', stage: 'issued', ...acme },
    },
  } as unknown as typeof tls.$inferSelect
}

test('a listed certificate says it will not renew, and shows no renewal or retry time', () => {
  const now = new Date('2026-11-04T00:00:00.000Z')
  const shown = toApiDnsCertificate(
    row({ renewAt: '2026-12-01T00:00:00.000Z', nextAttemptAt: '2026-11-05T00:00:00.000Z' }),
    now
  )
  assertEquals(
    [shown.status, shown.warning, shown.renewAt, shown.nextAttemptAt, shown.notAfter],
    ['ready', NO_RENEWAL_MESSAGE, null, null, '2027-01-01T00:00:00.000Z']
  )
  // Not on an order left open or a certificate that has expired.
  assertEquals(toApiDnsCertificate({ ...row({}), status: 'pending' }, now).warning, null)
  assertEquals(
    toApiDnsCertificate({ ...row({}), notAfter: '2026-01-01T00:00:00.000Z' }, now).warning,
    null
  )
  // A warning about the certificate itself is kept as it is.
  assertEquals(
    toApiDnsCertificate(row({ warning: 'The token is gone.' }), now).warning,
    'The token is gone.'
  )
})

test('an order placed by a server shows its renewal and retry times and no no-renewal warning', () => {
  const now = new Date('2026-11-04T00:00:00.000Z')
  const ordered = {
    ...row({
      challengeType: 'dns-01',
      renewAt: '2026-12-01T00:00:00.000Z',
      nextAttemptAt: '2026-11-05T00:00:00.000Z',
    }),
    source: 'lets_encrypt',
  } as unknown as typeof tls.$inferSelect
  const shown = toApiDnsCertificate(ordered, now)
  assertEquals(
    [shown.warning, shown.renewAt, shown.nextAttemptAt],
    [null, '2026-12-01T00:00:00.000Z', '2026-11-05T00:00:00.000Z']
  )
})
