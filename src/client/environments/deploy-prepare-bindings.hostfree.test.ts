/**
 * A deploy must not start a service against a managed database whose first
 * apply never finished.
 */

import { assertEquals } from '@std/assert'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { resolveBindingMaterializationOutcome } from './deploy-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

interface BoundManagedFixture {
  serviceId: string
  status: string
  metadata: unknown
}

/**
 * A db holding one row per (binding, login, managed) chain. The query's `where`
 * is rendered to SQL and its parameters read back, so only the chains of the
 * service ids the code asked about come out: a query that drops the filter
 * returns the other services' rows and the tests fail.
 */
function boundManagedDb(chains: BoundManagedFixture[]): Db {
  const dialect = new PgDialect()
  const chain: {
    innerJoin: () => typeof chain
    where: (clause: SQL) => Promise<unknown[]>
  } = {
    innerJoin: () => chain,
    where: (clause) => {
      const asked = new Set(dialect.sqlToQuery(clause).params)
      return Promise.resolve(chains.filter((row) => asked.has(row.serviceId)))
    },
  }
  return { select: () => ({ from: () => chain }) } as unknown as Db
}

const failedFirstApply = [
  { serviceId: 'svc', status: 'failed', metadata: { error: 'compose up failed' } },
]

test('deploy refuses a service bound to a database that failed to provision', async () => {
  const outcome = await resolveBindingMaterializationOutcome(
    boundManagedDb(failedFirstApply),
    undefined,
    ['svc'],
    'deploy'
  )
  assertEquals(outcome, { kind: 'error', error: { kind: 'binding_endpoint_unavailable' } })
})

test('preview only warns about a database that failed to provision', async () => {
  const outcome = await resolveBindingMaterializationOutcome(
    boundManagedDb(failedFirstApply),
    undefined,
    ['svc'],
    'preview'
  )
  assertEquals(outcome.kind, 'warn')
})

test('deploy goes on when the bound database is provisioned', async () => {
  const outcome = await resolveBindingMaterializationOutcome(
    boundManagedDb([
      { serviceId: 'svc', status: 'ready', metadata: { host: 'db.example.net', port: 5432 } },
      { serviceId: 'unrelated', status: 'failed', metadata: {} },
    ]),
    undefined,
    ['svc'],
    'deploy'
  )
  assertEquals(outcome, { kind: 'ok' })
})
