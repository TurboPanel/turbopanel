/**
 * Host-free org context helpers (mock Db — no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { Db } from '../db.ts'
import {
  canAccessOrganization,
  listAccessibleOrganizations,
  ORG_ID_HEADER,
  parseOrgIdFromRequest,
  resolveOrgId,
} from './org-context.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableLimit(rows: unknown[]) {
  return {
    limit: () => Promise.resolve(rows),
  }
}

function mockContext(input: {
  headers?: Record<string, string>
  query?: Record<string, string>
  db?: Db
}): Context {
  const headers = input.headers ?? {}
  const query = input.query ?? {}
  const vars = new Map<string, unknown>()
  if (input.db) vars.set('db', input.db)

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      query: (name: string) => query[name],
    },
    get: (key: string) => vars.get(key),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context
}

test('parseOrgIdFromRequest accepts header and rejects invalid UUIDs', () => {
  const ok = mockContext({
    headers: {
      [ORG_ID_HEADER]: '00000000-0000-4000-8000-000000000010',
    },
  })
  assertEquals(
    parseOrgIdFromRequest(ok),
    '00000000-0000-4000-8000-000000000010',
  )

  const fromQuery = mockContext({
    query: { organizationId: '00000000-0000-4000-8000-000000000011' },
  })
  assertEquals(
    parseOrgIdFromRequest(fromQuery),
    '00000000-0000-4000-8000-000000000011',
  )

  const missingResult = parseOrgIdFromRequest(mockContext({}))
  assertEquals(missingResult instanceof Response, true)
  assertEquals((missingResult as Response).status, 400)

  const invalidResult = parseOrgIdFromRequest(
    mockContext({
      headers: { [ORG_ID_HEADER]: 'not-a-uuid' },
    }),
  )
  assertEquals(invalidResult instanceof Response, true)
  assertEquals((invalidResult as Response).status, 400)
})

test('resolveOrgId returns 503 when db is unavailable', async () => {
  const c = mockContext({
    headers: { [ORG_ID_HEADER]: '00000000-0000-4000-8000-000000000010' },
  })
  const result = await resolveOrgId(c, 'user-1')
  assertEquals(result instanceof Response, true)
  assertEquals((result as Response).status, 503)
})

test('resolveOrgId returns organization id for platform admins', async () => {
  const orgId = '00000000-0000-4000-8000-000000000010'
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ role: 'superadmin' }]),
      }),
    }),
  } as unknown as Db

  const c = mockContext({
    headers: { [ORG_ID_HEADER]: orgId },
    db,
  })

  const result = await resolveOrgId(c, 'admin-user')
  assertEquals(result, orgId)
})

test('canAccessOrganization allows platform admins without team membership', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ role: 'admin' }]),
      }),
    }),
  } as unknown as Db
  assertEquals(await canAccessOrganization(db, 'u', 'org'), true)
})

test('canAccessOrganization allows team membership hits', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ role: 'user' }]),
        innerJoin: () => ({
          where: () => thenableLimit([{ id: 'tm1' }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await canAccessOrganization(db, 'u', 'org'), true)
})

test('listAccessibleOrganizations returns team-scoped orgs for regular users', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ role: 'user' }]),
      }),
    }),
    execute: () =>
      Promise.resolve([
        {
          id: 'o2',
          displayName: 'Member Org',
          createdAt: '2020-01-01T00:00:00.000Z',
        },
      ]),
  } as unknown as Db

  const orgs = await listAccessibleOrganizations(db, 'member-user')
  assertEquals(orgs.length, 1)
  assertEquals(orgs[0]?.displayName, 'Member Org')
})

test('listAccessibleOrganizations returns all orgs for superadmin', async () => {
  let n = 0
  const db = {
    select: () => ({
      from: () => {
        n += 1
        if (n === 1) {
          return {
            where: () => thenableLimit([{ role: 'superadmin' }]),
          }
        }
        return {
          orderBy: () =>
            Promise.resolve([
              {
                id: 'o1',
                displayName: 'Acme',
                createdAt: 't0',
              },
            ]),
        }
      },
    }),
  } as unknown as Db
  const orgs = await listAccessibleOrganizations(db, 'admin')
  assertEquals(orgs[0]?.displayName, 'Acme')
})
