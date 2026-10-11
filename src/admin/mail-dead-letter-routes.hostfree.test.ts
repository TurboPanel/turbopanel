import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { ADMIN_API_PREFIX } from '../app/surfaces.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from '../client/authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import {
  type MailDeadLetterStore,
  MailQueueUnavailableError,
} from '../features/email/smtp/dead-letter-replay.ts'
import { deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { registerAdminRoutes } from './routes.ts'

const test = Deno.test.bind(Deno)

const BASE = `${ADMIN_API_PREFIX}/mail/dead-letters`

type Calls = { list: number[]; one: string[]; all: number[] }

function fakeStore(overrides: Partial<MailDeadLetterStore> = {}) {
  const calls: Calls = { list: [], one: [], all: [] }
  const store: MailDeadLetterStore = {
    list: (limit) => {
      calls.list.push(limit)
      return Promise.resolve({
        total: 1,
        items: [
          {
            id: 'm-1',
            jobType: 'email-otp',
            to: 'j***@example.com',
            failedAttempts: 5,
            reason: 'gave up',
            deadAt: '2026-10-05T12:00:00.000Z',
          },
        ],
      })
    },
    replayOne: (id) => {
      calls.one.push(id)
      return Promise.resolve({ replayed: id === 'm-1' })
    },
    replayAll: (limit) => {
      calls.all.push(limit)
      return Promise.resolve({ replayed: 3, failed: 0, remaining: 0 })
    },
    ...overrides,
  }
  return { store, calls }
}

async function buildApp(opts: {
  role?: 'admin' | 'superadmin' | 'user'
  store?: MailDeadLetterStore
}) {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `dlq-${crypto.randomUUID()}@example.com`,
    role: opts.role ?? 'admin',
  })
  const db = createMockAuthDb(state)
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerAdminRoutes(app, {
    secrets,
    runtime: 'deno',
    devSurface: false,
    collectInstanceIps: () => [],
    ...(opts.store ? { mailDeadLetters: opts.store } : {}),
  })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { app, call }
}

test('every dead-letter route refuses a signed-out caller and a non-admin', async () => {
  const { store, calls } = fakeStore()
  const signedOut = await buildApp({ store })
  for (const [method, path] of [
    ['GET', ''],
    ['POST', '/replay-all'],
    ['POST', '/m-1/replay'],
  ] as const) {
    const res = await signedOut.app.request(`${BASE}${path}`, { method })
    assertEquals(res.status, 401, `${method} ${path}`)
  }
  const user = await buildApp({ role: 'user', store })
  for (const [method, path] of [
    ['GET', ''],
    ['POST', '/replay-all'],
    ['POST', '/m-1/replay'],
  ] as const) {
    assertEquals((await user.call(method, path)).status, 403, `${method} ${path}`)
  }
  assertEquals(calls, { list: [], one: [], all: [] })
})

test('an admin and a superadmin can list, with the default page size', async () => {
  for (const role of ['admin', 'superadmin'] as const) {
    const { store, calls } = fakeStore()
    const { call } = await buildApp({ role, store })
    const res = await call('GET', '')
    assertEquals(res.status, 200)
    const body = (await res.json()) as { total: number; items: { id: string }[] }
    assertEquals(body.total, 1)
    assertEquals(body.items[0]!.id, 'm-1')
    assertEquals(calls.list, [50])
  }
})

test('list passes a valid limit through and refuses a bad one before asking the broker', async () => {
  const { store, calls } = fakeStore()
  const { call } = await buildApp({ store })
  assertEquals((await call('GET', '?limit=10')).status, 200)
  for (const bad of ['0', '101', 'abc', '-1', '1.5']) {
    assertEquals((await call('GET', `?limit=${bad}`)).status, 400, bad)
  }
  assertEquals(calls.list, [10])
})

test('replay one answers 200 for a known id and 404 for an unknown one', async () => {
  const { store, calls } = fakeStore()
  const { call } = await buildApp({ store })
  const ok = await call('POST', '/m-1/replay')
  assertEquals(ok.status, 200)
  assertEquals(await ok.json(), { replayed: 1 })
  assertEquals((await call('POST', '/gone/replay')).status, 404)
  assertEquals(calls.one, ['m-1', 'gone'])
})

test('replay all uses the whole queue by default and honours a limit', async () => {
  const { store, calls } = fakeStore()
  const { call } = await buildApp({ store })
  const res = await call('POST', '/replay-all')
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { replayed: 3, failed: 0, remaining: 0 })
  assertEquals((await call('POST', '/replay-all', { limit: 5 })).status, 200)
  for (const bad of [0, 1001, 'x', 1.5]) {
    assertEquals((await call('POST', '/replay-all', { limit: bad })).status, 400, String(bad))
  }
  assertEquals(calls.all, [1000, 5])
})

test('an empty queue lists empty and replays nothing', async () => {
  const { store } = fakeStore({
    list: () => Promise.resolve({ total: 0, items: [] }),
    replayAll: () => Promise.resolve({ replayed: 0, failed: 0, remaining: 0 }),
  })
  const { call } = await buildApp({ store })
  assertEquals(await (await call('GET', '')).json(), { total: 0, items: [] })
  assertEquals(await (await call('POST', '/replay-all')).json(), {
    replayed: 0,
    failed: 0,
    remaining: 0,
  })
})

test('without a store (Workers, or no broker) every route says it is not available here', async () => {
  const { call } = await buildApp({})
  for (const [method, path] of [
    ['GET', ''],
    ['POST', '/replay-all'],
    ['POST', '/m-1/replay'],
  ] as const) {
    const res = await call(method, path)
    assertEquals(res.status, 501, `${method} ${path}`)
    assertEquals(((await res.json()) as { error: string }).error, 'mail_dead_letters_unsupported')
  }
})

test('a broker that cannot be reached answers 503 with a plain message', async () => {
  const down = () => Promise.reject(new MailQueueUnavailableError('mail queue unreachable: x'))
  const { store } = fakeStore({ list: down, replayOne: down, replayAll: down })
  const { call } = await buildApp({ store })
  for (const [method, path] of [
    ['GET', ''],
    ['POST', '/replay-all'],
    ['POST', '/m-1/replay'],
  ] as const) {
    const res = await call(method, path)
    assertEquals(res.status, 503, `${method} ${path}`)
    const body = (await res.json()) as { error: string; message: string }
    assertEquals(body.error, 'mail_queue_unavailable')
    assertEquals(body.message.includes('ECONN'), false)
  }
})
