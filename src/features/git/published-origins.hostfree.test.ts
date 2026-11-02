/**
 * Host-free coverage for the published Git origins: the hosted address joins
 * the list only on the hosted runtime, and only as a usable https origin.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { instanceHostname, setting } from '../../db/schema.ts'
import {
  listPublishedOrigins,
  matchPublishedOrigin,
  platformManagedOrigin,
  preferredPublishedOrigin,
  resolvePublishedOrigins,
} from './published-origins.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const HOSTED_ENV = { TURBOPANEL_BASE_URL: 'https://panel.example.com' }

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: () => promise,
    orderBy: () => promise,
  })
}

/** A database whose hostname table holds `hosts`, nothing else. */
function hostnamesDb(hosts: string[] = []): Db {
  const rows = hosts.map((host, index) => ({
    id: `host-${index}`,
    host,
    source: 'platform-ca',
    uploadedCertId: null,
    acmeLastAttemptAt: null,
    acmeLastError: null,
    notAfter: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }))
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === instanceHostname) return thenableRows(rows.map((row) => ({ ...row })))
          if (table === setting) return thenableRows([])
          return thenableRows([])
        },
      }),
    }),
  } as unknown as Db
}

test('platformManagedOrigin reads the base URL on the hosted runtime only', () => {
  assertEquals(
    platformManagedOrigin({ runtime: 'workers', platformEnv: HOSTED_ENV }),
    'https://panel.example.com'
  )
  assertEquals(
    platformManagedOrigin({
      runtime: 'workers',
      platformEnv: { TURBOPANEL_BASE_URL: ' https://panel.example.com/ ' },
    }),
    'https://panel.example.com'
  )
  // Self-hosted publishes the operator list only, whatever the env says.
  assertEquals(platformManagedOrigin({ runtime: 'deno', platformEnv: HOSTED_ENV }), null)
  assertEquals(platformManagedOrigin({ platformEnv: HOSTED_ENV }), null)
})

test('platformManagedOrigin ignores a blank, plaintext or unusable base URL', () => {
  for (const value of [undefined, '', '   ', 'http://panel.example.com', 'not a url']) {
    assertEquals(
      platformManagedOrigin({ runtime: 'workers', platformEnv: { TURBOPANEL_BASE_URL: value } }),
      null,
      String(value)
    )
  }
  assertEquals(platformManagedOrigin({ runtime: 'workers' }), null)
})

test('platformManagedOrigin keeps a non-default port and drops an explicit 443', () => {
  assertEquals(
    platformManagedOrigin({
      runtime: 'workers',
      platformEnv: { TURBOPANEL_BASE_URL: 'https://panel.example.com:443' },
    }),
    'https://panel.example.com'
  )
  assertEquals(
    platformManagedOrigin({
      runtime: 'workers',
      platformEnv: { TURBOPANEL_BASE_URL: 'https://panel.example.com:9443' },
    }),
    'https://panel.example.com:9443'
  )
})

test('listPublishedOrigins puts the platform address ahead of the stored list', async () => {
  assertEquals(await listPublishedOrigins(hostnamesDb()), [])
  assertEquals(await listPublishedOrigins(hostnamesDb(), 'https://panel.example.com'), [
    'https://panel.example.com',
  ])
  assertEquals(
    await listPublishedOrigins(hostnamesDb(['hooks.example.com']), 'https://panel.example.com'),
    ['https://panel.example.com', 'https://hooks.example.com:8443']
  )
  assertEquals(await listPublishedOrigins(hostnamesDb(['hooks.example.com'])), [
    'https://hooks.example.com:8443',
  ])
})

test('resolvePublishedOrigins reports the runtime beside the origins', async () => {
  assertEquals(
    await resolvePublishedOrigins(hostnamesDb(), { runtime: 'workers', platformEnv: HOSTED_ENV }),
    { origins: ['https://panel.example.com'], platformManaged: true }
  )
  assertEquals(
    await resolvePublishedOrigins(hostnamesDb(), {
      runtime: 'workers',
      platformEnv: { TURBOPANEL_BASE_URL: 'http://panel.example.com' },
    }),
    { origins: [], platformManaged: true }
  )
  assertEquals(
    await resolvePublishedOrigins(hostnamesDb(), { runtime: 'deno', platformEnv: HOSTED_ENV }),
    { origins: [], platformManaged: false }
  )
  assertEquals(await resolvePublishedOrigins(hostnamesDb(['panel.lan']), { runtime: 'deno' }), {
    origins: ['https://panel.lan:8443'],
    platformManaged: false,
  })
})

test('preferredPublishedOrigin is the first https origin, else the first, else null', () => {
  assertEquals(preferredPublishedOrigin([]), null)
  assertEquals(preferredPublishedOrigin(['https://a.example.com']), 'https://a.example.com')
  assertEquals(
    preferredPublishedOrigin(['ftp://a.example.com', 'https://b.example.com']),
    'https://b.example.com'
  )
  assertEquals(preferredPublishedOrigin(['ftp://a.example.com']), 'ftp://a.example.com')
})

test('matchPublishedOrigin accepts either spelling of a published origin and nothing else', () => {
  const origins = ['https://panel.example.com', 'https://hooks.example.com:8443']
  assertEquals(
    matchPublishedOrigin(origins, 'https://panel.example.com'),
    'https://panel.example.com'
  )
  assertEquals(
    matchPublishedOrigin(origins, 'https://panel.example.com/'),
    'https://panel.example.com'
  )
  assertEquals(
    matchPublishedOrigin(origins, 'https://hooks.example.com'),
    'https://hooks.example.com:8443'
  )
  assertEquals(matchPublishedOrigin(origins, 'hooks.example.com'), 'https://hooks.example.com:8443')
  assertEquals(matchPublishedOrigin(origins, 'https://other.example.com'), null)
  assertEquals(matchPublishedOrigin(origins, 'http://panel.example.com'), null)
  assertEquals(matchPublishedOrigin([], 'https://panel.example.com'), null)
})

test('matchPublishedOrigin maps an old :8443 webhook address to the same host published on 443', () => {
  const origins = ['https://panel.example.com']
  assertEquals(
    matchPublishedOrigin(origins, 'https://panel.example.com:8443'),
    'https://panel.example.com'
  )
  assertEquals(matchPublishedOrigin(origins, 'https://other.example.com:8443'), null)
})
