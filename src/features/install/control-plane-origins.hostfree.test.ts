/**
 * Host-free coverage for where the control plane's hostnames come from: the
 * platform environment on Workers (rows ignored, no port), the stored rows on
 * Deno (environment ignored).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { instanceHostname } from '../../db/schema.ts'
import {
  controlPlaneHostnameRows,
  controlPlaneOrigins,
  platformControlPlaneOrigin,
  platformControlPlaneOrigins,
} from './control-plane-origins.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** A database whose hostname table holds one primary row on 8443. */
function oneRowDb(host: string): Db {
  const rows = [
    {
      id: 'host-0',
      host,
      source: 'platform-ca',
      mode: 'direct',
      publicPort: 8443,
      isPrimary: true,
      isDaemonDial: true,
      uploadedCertId: null,
      acmeLastAttemptAt: null,
      acmeLastError: null,
      notAfter: null,
      ingressId: null,
      ingressState: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ]
  const result = (table: unknown) => {
    const promise = Promise.resolve(table === instanceHostname ? rows : [])
    return Object.assign(promise, { limit: () => promise, orderBy: () => promise })
  }
  return {
    select: () => ({ from: (table: unknown) => ({ where: () => result(table) }) }),
  } as unknown as Db
}

test('platform origins: base URL first, then the public URL list, port-free and de-duplicated', () => {
  assertEquals(
    platformControlPlaneOrigins({
      TURBOPANEL_BASE_URL: 'https://panel.example.com:443',
      TURBOPANEL_PUBLIC_URLS:
        'panel.example.com:8443, https://alt.example.com:9443/,http://plain.example.com',
    }),
    ['https://panel.example.com', 'https://alt.example.com']
  )
  assertEquals(platformControlPlaneOrigins({}), [])
  assertEquals(platformControlPlaneOrigins(undefined), [])
  assertEquals(platformControlPlaneOrigin({ TURBOPANEL_BASE_URL: '  ' }), null)
  assertEquals(
    platformControlPlaneOrigin({ TURBOPANEL_PUBLIC_URLS: 'hosted.example.com' }),
    'https://hosted.example.com'
  )
})

test('Workers: a stored row is ignored and the platform origin is the only one', async () => {
  const db = oneRowDb('stale.example.com')
  assertEquals(await controlPlaneHostnameRows(db, 'workers'), [])
  assertEquals(
    await controlPlaneOrigins(db, {
      runtime: 'workers',
      platformEnv: { TURBOPANEL_BASE_URL: 'https://panel.example.com' },
    }),
    ['https://panel.example.com']
  )
  assertEquals(await controlPlaneOrigins(db, { runtime: 'workers', platformEnv: {} }), [])
})

test('Deno: the stored rows are the only source, whatever the environment says', async () => {
  const db = oneRowDb('panel.lan')
  assertEquals((await controlPlaneHostnameRows(db, 'deno')).length, 1)
  assertEquals(
    await controlPlaneOrigins(db, {
      runtime: 'deno',
      platformEnv: { TURBOPANEL_BASE_URL: 'https://env.example.com' },
    }),
    ['https://panel.lan:8443']
  )
  assertEquals(await controlPlaneOrigins(undefined, { runtime: 'deno' }), [])
})
