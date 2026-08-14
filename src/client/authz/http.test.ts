import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { WORKSPACE_KIND_TURBOPANEL, WORKSPACE_KIND_USER } from '../../lib/db/workspace-kind.ts'
import {
  assertCanOr403,
  assertNotSystemOwnedOr403,
  assertOrgOwnerOr403,
  SYSTEM_RESOURCE_IMMUTABLE_ERROR,
} from './http.ts'

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
  } as unknown as Context
}

function createCanDb(allowed: boolean): Db {
  return {
    execute: () => Promise.resolve([{ allowed }]),
  } as unknown as Db
}

function createWorkspaceKindDb(kind: string): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ kind }]),
        }),
      }),
    }),
  } as unknown as Db
}

function createServiceKindDb(kind: string): Db {
  return {
    execute: () => Promise.resolve([{ kind }]),
  } as unknown as Db
}

test('assertCanOr403 returns 503 when database is unavailable', async () => {
  const denied = await assertCanOr403(
    createMockContext({ session: { userId: 'user-1' } }),
    'organization:manage',
    'organization',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when db is missing')
  }
  assertEquals(denied.status, 503)
  assertEquals(await denied.json(), { ok: false, error: 'Database unavailable' })
})

test('assertCanOr403 returns 401 when session is missing', async () => {
  const denied = await assertCanOr403(
    createMockContext({ db: createCanDb(true) }),
    'organization:manage',
    'organization',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when session is missing')
  }
  assertEquals(denied.status, 401)
  assertEquals(await denied.json(), { ok: false, error: 'Unauthorized' })
})

test('assertCanOr403 returns 403 when permission check fails', async () => {
  const denied = await assertCanOr403(
    createMockContext({
      db: createCanDb(false),
      session: { userId: 'user-1' },
    }),
    'organization:manage',
    'organization',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when access is denied')
  }
  assertEquals(denied.status, 403)
  assertEquals(await denied.json(), { ok: false, error: 'Forbidden' })
})

test('assertCanOr403 returns null when permission check passes', async () => {
  const denied = await assertCanOr403(
    createMockContext({
      db: createCanDb(true),
      session: { userId: 'user-1' },
    }),
    'organization:own',
    'organization',
    entityId,
  )

  assertEquals(denied, null)
})

test('assertOrgOwnerOr403 allows owners through the org owner check', async () => {
  const denied = await assertOrgOwnerOr403(
    createMockContext({
      db: createCanDb(true),
      session: { userId: 'user-1' },
    }),
    'team',
    entityId,
  )

  assertEquals(denied, null)
})

test('assertNotSystemOwnedOr403 returns 503 when database is unavailable', async () => {
  const denied = await assertNotSystemOwnedOr403(
    createMockContext({}),
    'project',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response when db is missing')
  }
  assertEquals(denied.status, 503)
  assertEquals(await denied.json(), { error: 'Database unavailable' })
})

test('assertNotSystemOwnedOr403 returns 403 for system workspace descendants', async () => {
  const denied = await assertNotSystemOwnedOr403(
    createMockContext({ db: createWorkspaceKindDb(WORKSPACE_KIND_TURBOPANEL) }),
    'workspace',
    entityId,
  )

  if (!(denied instanceof Response)) {
    throw new TypeError('expected Response for system-owned entity')
  }
  assertEquals(denied.status, 403)
  assertEquals(await denied.json(), { error: SYSTEM_RESOURCE_IMMUTABLE_ERROR })
})

test('assertNotSystemOwnedOr403 allows user workspace descendants', async () => {
  const denied = await assertNotSystemOwnedOr403(
    createMockContext({ db: createServiceKindDb(WORKSPACE_KIND_USER) }),
    'service',
    entityId,
  )

  assertEquals(denied, null)
})

test('assertNotSystemOwnedOr403 allows entities without workspace ancestry', async () => {
  const denied = await assertNotSystemOwnedOr403(
    createMockContext({ db: createCanDb(true) }),
    'network',
    entityId,
  )

  assertEquals(denied, null)
})
