import { assertEquals, assertThrows } from '@std/assert'
import {
  getDatabaseUrl,
  parsePostgresDatabaseUrl,
  postgresConfigFromEnv,
  postgresConfigFromUrl,
  resolvePostgresConnection,
  resolvePostgresConnectionParts,
} from './db-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parsePostgresDatabaseUrl accepts TCP and rejects non-postgres schemes', () => {
  assertEquals(
    parsePostgresDatabaseUrl('postgresql://turbopanel:secret@127.0.0.1:5432/turbopanel'),
    { user: 'turbopanel', database: 'turbopanel', transport: 'tcp' },
  )
  assertEquals(parsePostgresDatabaseUrl('mysql://u:p@h/db'), undefined)
  assertEquals(parsePostgresDatabaseUrl('not-a-url'), undefined)
})

test('resolvePostgresConnectionParts handles socket ?host= via URL parser', () => {
  const parts = resolvePostgresConnectionParts(
    'postgresql://turbopanel:s3cret@localhost/turbopanel?host=/run/turbopanel/postgres',
  )
  assertEquals(parts?.user, 'turbopanel')
  assertEquals(parts?.database, 'turbopanel')
  assertEquals(parts?.socketDir, '/run/turbopanel/postgres')
  assertEquals(parts?.tcpUrl, null)
  assertEquals(parts?.pass, 's3cret')
})

test('resolvePostgresConnectionParts falls back for @/db Unix-socket URLs', () => {
  const parts = resolvePostgresConnectionParts(
    'postgresql://turbopanel:s3cret@/turbopanel?host=/run/turbopanel/postgres',
  )
  assertEquals(parts?.socketDir, '/run/turbopanel/postgres')
  assertEquals(parts?.user, 'turbopanel')
  assertEquals(parts?.database, 'turbopanel')
  assertEquals(parts?.tcpUrl, null)
})

test('resolvePostgresConnectionParts rejects socket URL without host query', () => {
  assertEquals(
    resolvePostgresConnectionParts('postgresql://turbopanel@/turbopanel'),
    undefined,
  )
  assertEquals(
    resolvePostgresConnectionParts('postgresql://@/turbopanel?host=/tmp'),
    undefined,
  )
})

test('resolvePostgresConnection returns tcp string or socket object', () => {
  const tcp = resolvePostgresConnection(
    'postgresql://turbopanel:x@127.0.0.1:5432/turbopanel',
  )
  assertEquals(typeof tcp, 'string')

  const socket = resolvePostgresConnection(
    'postgresql://turbopanel:x@/turbopanel?host=/run/turbopanel/postgres',
  )
  assertEquals(socket, {
    host: '/run/turbopanel/postgres',
    database: 'turbopanel',
    user: 'turbopanel',
    pass: 'x',
  })

  assertThrows(
    () => resolvePostgresConnection('http://example.com'),
    Error,
    'invalid TURBOPANEL_DATABASE_URL',
  )
})

test('postgresConfigFromUrl and env helpers report configured transport', () => {
  assertEquals(postgresConfigFromUrl(undefined), {
    configured: false,
    transport: null,
    user: null,
    database: null,
  })
  assertEquals(postgresConfigFromUrl('   '), {
    configured: false,
    transport: null,
    user: null,
    database: null,
  })
  assertEquals(postgresConfigFromUrl('not-postgres'), {
    configured: false,
    transport: null,
    user: null,
    database: null,
  })
  assertEquals(
    postgresConfigFromUrl(
      'postgresql://turbopanel:x@127.0.0.1:5432/turbopanel',
    ),
    {
      configured: true,
      transport: 'tcp',
      user: 'turbopanel',
      database: 'turbopanel',
    },
  )

  // Env helpers exercise Deno.env path; shape must stay consistent.
  const fromEnv = postgresConfigFromEnv()
  assertEquals(typeof fromEnv.configured, 'boolean')
  const url = getDatabaseUrl()
  assertEquals(url === undefined || url.length > 0, true)
})
