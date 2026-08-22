import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../db.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  parseJsonBody,
} from './shared.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const entityId = '11111111-1111-4111-8111-111111111111'

function createMockContext(options: {
  db?: Db
  session?: { userId: string; role?: string }
  body?: string
}): Context {
  const store = new Map<string, unknown>()
  if (options.db !== undefined) {
    store.set('db', options.db)
  }
  if (options.session !== undefined) {
    store.set('session', options.session)
  }

  return {
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) => Response.json(body, { status }),
    req: {
      text: () => Promise.resolve(options.body ?? ''),
    },
  } as unknown as Context
}

function createCanDb(allowed: boolean): Db {
  return {
    execute: () => Promise.resolve([{ allowed }]),
  } as unknown as Db
}

test('assertCanManageOr403 returns 503 when database is unavailable', async () => {
  const denied = await assertCanManageOr403(
    createMockContext({ session: { userId: 'user-1' } }),
    'project',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when db is missing')
  }
  assertEquals(denied.status, 503)
})

test('assertCanManageOr403 returns 401 when session is missing', async () => {
  const denied = await assertCanManageOr403(
    createMockContext({ db: createCanDb(true) }),
    'project',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when session is missing')
  }
  assertEquals(denied.status, 401)
})

test('assertCanManageOr403 returns 403 when manage check fails', async () => {
  const denied = await assertCanManageOr403(
    createMockContext({
      db: createCanDb(false),
      session: { userId: 'user-1' },
    }),
    'environment',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when access is denied')
  }
  assertEquals(denied.status, 403)
  assertEquals(await denied.json(), { error: 'Forbidden' })
})

test('assertCanManageOr403 returns null when manage check passes', async () => {
  const denied = await assertCanManageOr403(
    createMockContext({
      db: createCanDb(true),
      session: { userId: 'user-1' },
    }),
    'hosting',
    entityId,
  )

  assertEquals(denied, null)
})

test('assertCanReadOr403 delegates to manage-level org access', async () => {
  const denied = await assertCanReadOr403(
    createMockContext({
      db: createCanDb(true),
      session: { userId: 'user-1' },
    }),
    'server',
    entityId,
  )

  assertEquals(denied, null)
})

test('assertCanReadOr403 returns 403 when manage check fails', async () => {
  const denied = await assertCanReadOr403(
    createMockContext({
      db: createCanDb(false),
      session: { userId: 'user-1' },
    }),
    'server',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when read access is denied')
  }
  assertEquals(denied.status, 403)
})

test('assertCanCreateOr403 delegates to manage-level org access', async () => {
  const denied = await assertCanCreateOr403(
    createMockContext({
      db: createCanDb(true),
      session: { userId: 'user-1' },
    }),
    'workspace',
    entityId,
  )

  assertEquals(denied, null)
})

test('assertCanCreateOr403 returns 403 when manage check fails', async () => {
  const denied = await assertCanCreateOr403(
    createMockContext({
      db: createCanDb(false),
      session: { userId: 'user-1' },
    }),
    'workspace',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when create access is denied')
  }
  assertEquals(denied.status, 403)
})

test('parseJsonBody returns empty object for blank body', async () => {
  const body = await parseJsonBody(createMockContext({ body: '   ' }))
  assertEquals(body, {})
})

test('parseJsonBody returns 400 for invalid JSON', async () => {
  const body = await parseJsonBody(createMockContext({ body: '{not json' }))
  if (!(body instanceof Response)) {
    throw new TypeError('expected Response for invalid JSON')
  }
  assertEquals(body.status, 400)
})

test('parseJsonBody returns 400 for non-object payloads', async () => {
  const arrayBody = await parseJsonBody(createMockContext({ body: '[]' }))
  if (!(arrayBody instanceof Response)) {
    throw new TypeError('expected Response for array JSON')
  }
  assertEquals(arrayBody.status, 400)

  const nullBody = await parseJsonBody(createMockContext({ body: 'null' }))
  if (!(nullBody instanceof Response)) {
    throw new TypeError('expected Response for null JSON')
  }
  assertEquals(nullBody.status, 400)
})

test('parseJsonBody returns empty object when request body read fails', async () => {
  const body = await parseJsonBody({
    json: (payload: unknown, status?: number) => Response.json(payload, { status }),
    req: {
      text: () => Promise.reject(new Error('broken stream')),
    },
  } as unknown as Context)

  assertEquals(body, {})
})

test('parseJsonBody parses object payloads', async () => {
  const body = await parseJsonBody(createMockContext({ body: '{"name":"alpha"}' }))
  if (body instanceof Response) {
    throw new TypeError('expected parsed object body')
  }
  assertEquals(body, { name: 'alpha' })
})
