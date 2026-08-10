/**
 * Host-free coverage for authz service pure helpers and simple grant lookups.
 *
 * canManage* paths call evaluator.can (complex SQL) — covered by service.test.ts
 * when the database is available.
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  assertNotLastOrgOwner,
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

function selectQueue(responses: unknown[][]): Db {
  let i = 0
  return {
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
  assertEquals(
    await canOwnOrganization(
      selectQueue([[{ role: 'superadmin' }]]),
      'u',
      'org',
    ),
    true,
  )
  assertEquals(
    await canOwnOrganization(
      selectQueue([[{ role: 'user' }], [{ id: 'g1' }]]),
      'u',
      'org',
    ),
    true,
  )
  assertEquals(
    await canOwnOrganization(
      selectQueue([[{ role: 'user' }], []]),
      'u',
      'org',
    ),
    false,
  )
  assertEquals(
    await canOwnOrganization(selectQueue([[]]), 'missing-user', 'org'),
    false,
  )
})

test('canOwnTeam: platform admin bypass and team own grant', async () => {
  assertEquals(
    await canOwnTeam(selectQueue([[{ role: 'admin' }]]), 'u', 'team'),
    true,
  )
  assertEquals(
    await canOwnTeam(
      selectQueue([[{ role: 'user' }], [{ id: 'g' }]]),
      'u',
      'team',
    ),
    true,
  )
  // userRole provided → only the team grant query runs.
  assertEquals(
    await canOwnTeam(selectQueue([[]]), 'u', 'team', 'user'),
    false,
  )
})

test('assertNotLastOrgOwner / assertNotLastTeamOwner', async () => {
  // Multiple owners — no throw.
  await assertNotLastOrgOwner(
    selectQueue([
      [{ actorId: 'other' }, { actorId: 'self' }],
    ]),
    'org',
    'self',
  )

  await assertRejects(
    () =>
      assertNotLastOrgOwner(
        selectQueue([[{ actorId: 'self' }]]),
        'org',
        'self',
      ),
    Error,
    'Cannot remove the last owner of an organization',
  )

  await assertNotLastTeamOwner(
    selectQueue([
      [{ actorId: 'other' }, { actorId: 'self' }],
    ]),
    'team',
    'self',
  )

  await assertRejects(
    () =>
      assertNotLastTeamOwner(
        selectQueue([[{ actorId: 'self' }]]),
        'team',
        'self',
      ),
    Error,
    'Cannot remove the last owner of a team',
  )

  // Sole other owner — removing self is fine (zero match).
  await assertNotLastOrgOwner(
    selectQueue([[{ actorId: 'other' }]]),
    'org',
    'self',
  )
})
