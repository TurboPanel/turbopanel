/**
 * Host-free canAccessOrganization paths (admin / membership; grant evaluator skipped).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../db.ts'
import {
  canAccessOrganization,
  listAccessibleOrganizations,
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

test('canAccessOrganization allows platform admins without membership', async () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ role: 'admin' }]),
      }),
    }),
  } as unknown as Db
  assertEquals(await canAccessOrganization(db, 'u', 'org'), true)
})

test('canAccessOrganization allows membership hits', async () => {
  let n = 0
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          n += 1
          if (n === 1) return thenableLimit([{ role: 'user' }])
          return thenableLimit([{ id: 'm1' }])
        },
      }),
    }),
  } as unknown as Db
  assertEquals(await canAccessOrganization(db, 'u', 'org'), true)
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
