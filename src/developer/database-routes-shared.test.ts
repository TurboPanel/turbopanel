import { assertEquals } from '@std/assert'

import { postgresConfigFromContext } from './database-routes-shared.ts'
import { postgresConfigFromEnv } from '../db-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function fakeContext(connectionString: string | undefined) {
  return {
    get(key: string) {
      if (key === 'postgresConnectionString') return connectionString
      return undefined
    },
  }
}

test('postgresConfigFromContext prefers a configured context connection string', () => {
  const meta = postgresConfigFromContext(
    fakeContext('postgresql://ctx:pw@127.0.0.1:5432/ctxdb') as never,
  )
  assertEquals(meta, {
    configured: true,
    transport: 'tcp',
    user: 'ctx',
    database: 'ctxdb',
  })
})

test('postgresConfigFromContext falls back to env when context URL is unusable', () => {
  const key = 'TURBOPANEL_DATABASE_URL'
  const previous = Deno.env.get(key)
  Deno.env.set(key, 'postgresql://env:pw@127.0.0.1:5432/envdb')
  try {
    const meta = postgresConfigFromContext(fakeContext('not-a-url') as never)
    assertEquals(meta, postgresConfigFromEnv())
    assertEquals(meta, {
      configured: true,
      transport: 'tcp',
      user: 'env',
      database: 'envdb',
    })
  } finally {
    if (previous === undefined) Deno.env.delete(key)
    else Deno.env.set(key, previous)
  }
})

test('postgresConfigFromContext falls back to env when context has no string', () => {
  const key = 'TURBOPANEL_DATABASE_URL'
  const previous = Deno.env.get(key)
  Deno.env.delete(key)
  try {
    const meta = postgresConfigFromContext(fakeContext(undefined) as never)
    assertEquals(meta.configured, false)
  } finally {
    if (previous === undefined) Deno.env.delete(key)
    else Deno.env.set(key, previous)
  }
})
