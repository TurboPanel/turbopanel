import { assertEquals } from '@std/assert'
import {
  buildConnectedDatabaseStatus,
  buildDatabaseClientUnavailableStatus,
  buildDatabaseQueryErrorStatus,
  buildDatabaseStudioProbeResponse,
  buildUnconfiguredDatabaseStatus,
} from './database-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const meta = {
  configured: true,
  transport: 'tcp' as const,
  user: 'turbopanel',
  database: 'turbopanel',
}

test('buildUnconfiguredDatabaseStatus preserves meta and error', () => {
  assertEquals(
    buildUnconfiguredDatabaseStatus(
      { configured: false, transport: null, user: null, database: null },
      'postgres is not configured (missing database URL)',
    ),
    {
      configured: false,
      transport: null,
      user: null,
      database: null,
      connected: false,
      version: null,
      error: 'postgres is not configured (missing database URL)',
    },
  )
})

test('buildDatabaseClientUnavailableStatus sets connected false', () => {
  assertEquals(buildDatabaseClientUnavailableStatus(meta), {
    ...meta,
    connected: false,
    version: null,
    error: 'database client failed to initialize',
  })
})

test('buildConnectedDatabaseStatus prefers query row database name', () => {
  assertEquals(
    buildConnectedDatabaseStatus(meta, {
      version: 'PostgreSQL 18',
      database: 'live-db',
    }),
    {
      ...meta,
      database: 'live-db',
      connected: true,
      version: 'PostgreSQL 18',
      error: null,
    },
  )
})

test('buildDatabaseQueryErrorStatus captures failure message', () => {
  assertEquals(buildDatabaseQueryErrorStatus(meta, 'connection refused'), {
    ...meta,
    connected: false,
    version: null,
    error: 'connection refused',
  })
})

test('buildDatabaseStudioProbeResponse mirrors probe fields', () => {
  assertEquals(
    buildDatabaseStudioProbeResponse({
      running: true,
      browserUrl: 'http://127.0.0.1:4983',
      port: 4983,
    }),
    {
      running: true,
      browserUrl: 'http://127.0.0.1:4983',
      port: 4983,
    },
  )
})
