/**
 * Host-free coverage for `GET /servers/:id/traffic-map`: the session gate, the
 * read-access gate, and that peers are limited to servers the viewer can
 * read (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { getTableName } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerTrafficMapRoutes } from './traffic-map-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '22222222-2222-4222-8222-222222222222'
const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const LAN = '00000000-0000-4000-8000-0000000000d1'

type Row = Record<string, unknown>

function rows<T>(value: T[]) {
  const promise = Promise.resolve(value)
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(value.slice(0, n)),
    orderBy: () => Promise.resolve(value),
  })
}

async function buildApp(options: { allowed: boolean; visible: string[] }) {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `tm-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `tm-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: ORG, name: 'Org' })
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as { select: (fields?: unknown) => { from: (table: unknown) => unknown } }
  ).select.bind(authDb)

  let executeCalls = 0
  const pin = (serverId: string, address: string) => ({
    ipId: `ip-${serverId}`,
    serverId,
    datacenterId: LAN,
    networkId: null,
    address,
    metadata: null,
  })
  const db = Object.assign(authDb, {
    // First call is the read check, the second is the visible-servers list.
    execute: () => {
      executeCalls += 1
      if (executeCalls === 1) {
        return Promise.resolve([{ allowed: options.allowed, organization_id: ORG }])
      }
      return Promise.resolve(options.visible.map((id) => ({ item_id: id })))
    },
    select: (fields?: Row) => ({
      from: (table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table)
        if (name === 'server') {
          if (fields && 'organizationId' in fields && Object.keys(fields).length === 1) {
            return { where: () => rows([{ organizationId: ORG }]) }
          }
          const all = [
            { id: A, name: 'adrastea', metadata: null },
            { id: B, name: 'kore', metadata: null },
            { id: C, name: 'secret-box', metadata: null },
          ]
          // The route's names query is `WHERE id IN (visible ids)`; the fake
          // cannot read the clause, so it applies the same filter itself.
          const onlyVisible = fields && !('metadata' in fields)
          return {
            where: () =>
              rows(onlyVisible ? all.filter((row) => options.visible.includes(row.id)) : all),
          }
        }
        if (name === 'ip' && fields && 'ipId' in fields) {
          return {
            where: () =>
              rows([pin(A, '192.168.1.10'), pin(B, '192.168.1.11'), pin(C, '192.168.1.99')]),
          }
        }
        if (name === 'datacenter') {
          return {
            where: () =>
              rows(
                fields && 'options' in fields
                  ? [{ id: LAN, options: {} }]
                  : [{ id: LAN, name: 'Office LAN' }]
              ),
          }
        }
        if (name === 'ip' || name === 'relay' || name === 'fabric' || name === 'generation') {
          return {
            where: () => rows([]),
            innerJoin: () => ({ where: () => rows([]), orderBy: () => rows([]) }),
          }
        }
        return origSelect(fields).from(table)
      },
    }),
  }) as unknown as Db

  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerServerTrafficMapRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, cookie }
}

test('GET /servers/:id/traffic-map needs a session', async () => {
  const { app } = await buildApp({ allowed: true, visible: [A, B] })
  const res = await app.request(`/servers/${A}/traffic-map`)
  assertEquals(res.status, 401)
})

test('GET /servers/:id/traffic-map refuses a viewer who cannot read the server', async () => {
  const { app, cookie } = await buildApp({ allowed: false, visible: [A, B] })
  const res = await app.request(`/servers/${A}/traffic-map`, {
    headers: { Cookie: cookie, [ORG_ID_HEADER]: ORG },
  })
  assertEquals(res.status === 403 || res.status === 404, true)
})

test('GET /servers/:id/traffic-map lists only peers the viewer can read', async () => {
  const { app, cookie } = await buildApp({ allowed: true, visible: [A, B] })
  const res = await app.request(`/servers/${A}/traffic-map`, {
    headers: { Cookie: cookie, [ORG_ID_HEADER]: ORG },
  })
  assertEquals(res.status, 200)
  const text = await res.text()
  const body = JSON.parse(text)
  assertEquals(body.ok, true)
  assertEquals(body.serverId, A)
  assertEquals(body.truncated, false)
  assertEquals(
    body.peers.map((peer: { serverId: string }) => peer.serverId),
    [B]
  )
  assertEquals(body.peers[0].chosenDatacenterId, LAN)
  // The server the viewer cannot read, and its address, never appear.
  assertEquals(text.includes('secret-box') || text.includes('192.168.1.99'), false)
})
