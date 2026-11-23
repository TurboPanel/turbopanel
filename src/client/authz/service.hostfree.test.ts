/**
 * Host-free coverage for authz service pure helpers and simple grant lookups.
 *
 * canManage* paths call evaluator.can (complex SQL) — covered by service.test.ts
 * when the database is available.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { assertNotLastOrgOwner } from './org-owners.ts'
import {
  assertNotLastTeamOwner,
  canOwnOrganization,
  canOwnTeam,
  isPlatformAdmin,
  isSuperAdmin,
} from './service.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableLimit(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function selectQueue(responses: unknown[][], executes: unknown[][] = []): Db {
  let i = 0
  let e = 0
  return {
    execute: () => {
      const rows = executes[e] ?? []
      e += 1
      return Promise.resolve(rows)
    },
    select: () => ({
      from: () => ({
        where: () => {
          const rows = responses[i] ?? []
          i += 1
          return thenableLimit(rows)
        },
      }),
    }),
  } as unknown as Db
}

test('isSuperAdmin / isPlatformAdmin', () => {
  assertEquals(isSuperAdmin({ id: '1', role: 'superadmin' }), true)
  assertEquals(isSuperAdmin({ id: '1', role: 'admin' }), false)
  assertEquals(isPlatformAdmin({ id: '1', role: 'admin' }), true)
  assertEquals(isPlatformAdmin({ id: '1', role: 'user' }), false)
})

test('canOwnOrganization: platform admin bypass and grant check', async () => {
  assertEquals(await canOwnOrganization(selectQueue([[{ role: 'superadmin' }]]), 'u', 'org'), true)
  assertEquals(
    await canOwnOrganization(selectQueue([[{ role: 'user' }]], [[{ allowed: true }]]), 'u', 'org'),
    true
  )
  assertEquals(
    await canOwnOrganization(selectQueue([[{ role: 'user' }]], [[{ allowed: false }]]), 'u', 'org'),
    false
  )
  assertEquals(await canOwnOrganization(selectQueue([[]]), 'missing-user', 'org'), false)
})

test('canOwnTeam: platform admin bypass and team own grant', async () => {
  assertEquals(await canOwnTeam(selectQueue([[{ role: 'admin' }]]), 'u', 'team'), true)
  assertEquals(
    await canOwnTeam(selectQueue([[{ role: 'user' }], [{ id: 'g' }]]), 'u', 'team'),
    true
  )
  // userRole provided → only the team grant query runs.
  assertEquals(await canOwnTeam(selectQueue([[]]), 'u', 'team', 'user'), false)
})

test('assertNotLastOrgOwner counts distinct active owners, not grant rows', async () => {
  // Another person still owns after the change: no throw.
  await assertNotLastOrgOwner(selectQueue([], [[{ id: 'other' }, { id: 'self' }]]), 'org', {
    userId: 'self',
  })
  await assertRejects(
    () =>
      assertNotLastOrgOwner(selectQueue([], [[{ id: 'self' }]]), 'org', {
        userId: 'self',
      }),
    Error,
    'Cannot remove the last owner of an organization'
  )
  // Revoking one grant: owners before, owners without that grant.
  await assertRejects(
    () =>
      assertNotLastOrgOwner(selectQueue([], [[{ id: 'self' }], []]), 'org', {
        grantId: '00000000-0000-0000-0000-000000000001',
      }),
    Error,
    'Cannot remove the last owner of an organization'
  )
  await assertNotLastOrgOwner(selectQueue([], [[{ id: 'self' }], [{ id: 'self' }]]), 'org', {
    grantId: '00000000-0000-0000-0000-000000000001',
  })
  // No owner today (only an empty team holds the grant): nothing to protect.
  await assertNotLastOrgOwner(selectQueue([], [[]]), 'org', { userId: 'self' })
})

test('assertNotLastTeamOwner', async () => {
  await assertNotLastTeamOwner(
    selectQueue([[{ actorId: 'other' }, { actorId: 'self' }]]),
    'team',
    'self'
  )

  await assertRejects(
    () => assertNotLastTeamOwner(selectQueue([[{ actorId: 'self' }]]), 'team', 'self'),
    Error,
    'Cannot remove the last owner of a team'
  )
})
