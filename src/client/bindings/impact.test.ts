/**
 * Host-free coverage for binding redeploy-impact helpers.
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  hasBindingsForDatabase,
  hasBindingsForPrincipal,
  listBindingImpactForDatabase,
  listBindingImpactForPrincipal,
} from './impact.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function joinChain(rows: unknown[]): Db {
  // listBindingImpact* uses select.from.innerJoin.innerJoin.where (and another join for DB).
  const terminal = {
    where: () => thenableRows(rows),
  }
  const chain = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => terminal,
            where: terminal.where,
          }),
          where: terminal.where,
        }),
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  }
  return chain as unknown as Db
}

test('listBindingImpactForPrincipal sorts by keyPrefix and sets count', async () => {
  const result = await listBindingImpactForPrincipal(
    joinChain([
      {
        serviceId: 's2',
        displayName: 'B',
        environmentId: 'e1',
        projectId: 'p1',
        keyPrefix: 'ZZZ',
      },
      {
        serviceId: 's1',
        displayName: 'A',
        environmentId: 'e1',
        projectId: 'p1',
        keyPrefix: 'AAA',
      },
    ]),
    'principal-1',
  )
  assertEquals(result.count, 2)
  assertEquals(result.services.map((s) => s.keyPrefix), ['AAA', 'ZZZ'])
  assertEquals(result.services[0]?.serviceId, 's1')
})

test('listBindingImpactForDatabase returns empty impact shape', async () => {
  const result = await listBindingImpactForDatabase(joinChain([]), {
    managedId: 'm1',
    databaseName: 'app',
  })
  assertEquals(result, { count: 0, services: [] })
})

test('hasBindingsForPrincipal is true only when a row exists', async () => {
  assertEquals(
    await hasBindingsForPrincipal(joinChain([{ id: 'b1' }]), 'principal-1'),
    true,
  )
  assertEquals(
    await hasBindingsForPrincipal(joinChain([]), 'principal-1'),
    false,
  )
})

test('hasBindingsForDatabase delegates to impact count', async () => {
  assertEquals(
    await hasBindingsForDatabase(
      joinChain([
        {
          serviceId: 's1',
          displayName: null,
          environmentId: 'e1',
          projectId: 'p1',
          keyPrefix: 'DB',
        },
      ]),
      { managedId: 'm1', databaseName: 'app' },
    ),
    true,
  )
  assertEquals(
    await hasBindingsForDatabase(joinChain([]), {
      managedId: 'm1',
      databaseName: 'app',
    }),
    false,
  )
})
